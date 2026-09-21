"""
A minimal RFC 6455 WebSocket implementation.

Brief:
    Enough of the protocol to carry Concert Mode's small JSON messages over
    a local network, and no more. Writing it from the RFC rather than taking
    a dependency keeps `python server/serve.py` a standard-library command,
    which is the whole promise of the bundled server.

Warning:
    Server side only, no extensions, no fragmentation, and a hard frame
    ceiling. It is not a general-purpose WebSocket library and should not be
    reached for as one.
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: The fixed GUID RFC 6455 mixes into the handshake accept value.
WEBSOCKET_GUID_STR = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

#: Frame opcodes this implementation understands.
OPCODE_TEXT_INT = 0x1
OPCODE_BINARY_INT = 0x2
OPCODE_CLOSE_INT = 0x8
OPCODE_PING_INT = 0x9
OPCODE_PONG_INT = 0xA

#: Largest frame accepted, in bytes. A Concert Mode message is under a
#: kilobyte; anything approaching this is a bug or an attack.
MAX_FRAME_BYTES_INT = 1 << 20

#: Largest handshake request accepted, in bytes.
MAX_HANDSHAKE_BYTES_INT = 65536

#: Payload lengths above these switch to the extended encodings.
SHORT_LENGTH_LIMIT_INT = 126
MEDIUM_LENGTH_LIMIT_INT = 1 << 16

#: Sentinel lengths that introduce a 16-bit or 64-bit extended length.
MEDIUM_LENGTH_MARKER_INT = 126
LONG_LENGTH_MARKER_INT = 127


class WebSocketError(Exception):
    """Raised when a peer closes or sends something unusable."""


def receive_exactly(client_socket, byte_count_int):
    """
    Read an exact number of bytes, or fail.

    Arguments:
        client_socket (socket.socket): Connected socket.
        byte_count_int (int): How many bytes are required.

    Returns:
        (bytes): Exactly byte_count_int bytes.

    Warning:
        Raises WebSocketError if the peer closes first. A short read is
        never returned, because every caller is parsing a fixed-width field
        and a partial one is meaningless.
    """
    buffer_bytes = b""
    while len(buffer_bytes) < byte_count_int:
        chunk_bytes = client_socket.recv(byte_count_int - len(buffer_bytes))
        if not chunk_bytes:
            raise WebSocketError("peer closed")
        buffer_bytes += chunk_bytes
    return buffer_bytes


def parse_request_headers(raw_bytes):
    """
    Parse the headers out of a raw HTTP request.

    Arguments:
        raw_bytes (bytes): The request up to the blank line.

    Returns:
        (dict): Header names lower-cased, mapped to their values.
    """
    head_str = raw_bytes.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    headers_dict = {}

    for line_str in head_str.split("\r\n")[1:]:
        if ":" not in line_str:
            continue
        name_str, value_str = line_str.split(":", 1)
        headers_dict[name_str.strip().lower()] = value_str.strip()

    return headers_dict


def complete_handshake(client_socket):
    """
    Complete the HTTP Upgrade exchange.

    Arguments:
        client_socket (socket.socket): Freshly accepted socket.

    Returns:
        (bool): True when the connection is now a WebSocket.

    Warning:
        Answers a malformed request with 400 and returns False rather than
        raising, so one bad client cannot take the relay thread down.
    """
    raw_bytes = b""
    while b"\r\n\r\n" not in raw_bytes:
        chunk_bytes = client_socket.recv(4096)
        if not chunk_bytes:
            return False
        raw_bytes += chunk_bytes
        if len(raw_bytes) > MAX_HANDSHAKE_BYTES_INT:
            return False

    headers_dict = parse_request_headers(raw_bytes)
    key_str = headers_dict.get("sec-websocket-key")
    is_upgrade_bool = headers_dict.get("upgrade", "").lower() == "websocket"

    if not key_str or not is_upgrade_bool:
        client_socket.sendall(
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
        )
        return False

    accept_str = base64.b64encode(
        hashlib.sha1((key_str + WEBSOCKET_GUID_STR).encode()).digest()
    ).decode()

    client_socket.sendall((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_str}\r\n\r\n"
    ).encode())
    return True


def read_payload_length(client_socket, first_length_int):
    """
    Resolve a frame's payload length, reading any extended field.

    Arguments:
        client_socket (socket.socket): Connected socket.
        first_length_int (int): The 7-bit length from the frame header.

    Returns:
        (int): The payload length in bytes.
    """
    if first_length_int == MEDIUM_LENGTH_MARKER_INT:
        return struct.unpack(">H", receive_exactly(client_socket, 2))[0]
    if first_length_int == LONG_LENGTH_MARKER_INT:
        return struct.unpack(">Q", receive_exactly(client_socket, 8))[0]
    return first_length_int


def read_frame(client_socket):
    """
    Read one frame from a peer.

    Arguments:
        client_socket (socket.socket): Connected socket.

    Returns:
        (tuple|None): (opcode_int, payload_bytes), or None on a close frame.

    Warning:
        Raises WebSocketError on an oversized frame. Client-to-server frames
        are always masked, and the mask is applied here so callers never see
        it.
    """
    header_bytes = receive_exactly(client_socket, 2)
    opcode_int = header_bytes[0] & 0x0F
    is_masked_bool = bool(header_bytes[1] & 0x80)

    length_int = read_payload_length(
        client_socket, header_bytes[1] & 0x7F
    )
    if length_int > MAX_FRAME_BYTES_INT:
        raise WebSocketError("frame too large")

    mask_bytes = receive_exactly(client_socket, 4) if is_masked_bool else None
    payload_bytes = (
        receive_exactly(client_socket, length_int) if length_int else b""
    )

    if mask_bytes:
        payload_bytes = bytes(
            byte_int ^ mask_bytes[index_int & 3]
            for index_int, byte_int in enumerate(payload_bytes)
        )

    if opcode_int == OPCODE_CLOSE_INT:
        return None
    return opcode_int, payload_bytes


def write_frame(client_socket, payload_bytes, opcode_int=OPCODE_TEXT_INT):
    """
    Send one unmasked frame.

    Arguments:
        client_socket (socket.socket): Connected socket.
        payload_bytes (bytes): The payload.
        opcode_int (int): Frame opcode; text by default.

    Returns:
        (none)

    Warning:
        Server-to-client frames are never masked, per the RFC.
    """
    header_bytearray = bytearray([0x80 | opcode_int])
    length_int = len(payload_bytes)

    if length_int < SHORT_LENGTH_LIMIT_INT:
        header_bytearray.append(length_int)
    elif length_int < MEDIUM_LENGTH_LIMIT_INT:
        header_bytearray.append(MEDIUM_LENGTH_MARKER_INT)
        header_bytearray += struct.pack(">H", length_int)
    else:
        header_bytearray.append(LONG_LENGTH_MARKER_INT)
        header_bytearray += struct.pack(">Q", length_int)

    client_socket.sendall(bytes(header_bytearray) + payload_bytes)
