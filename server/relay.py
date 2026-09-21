"""
The Concert Mode relay: a room-keyed broadcast hub.

Brief:
    Every message a peer sends is forwarded to the other members of its
    room, verbatim. The relay reads exactly two things out of a payload --
    whether it is a join and whether it is a clock probe -- and nothing
    else. Payloads are never stored, never logged and never inspected
    beyond those two envelope fields.

Warning:
    Intended for a trusted local network. There is no authentication: a room
    code is the only thing standing between two sessions, which is why the
    codes are drawn from an alphabet with no ambiguous glyphs and are not
    guessable in a small space.
"""

from __future__ import annotations

import json
import socket
import sys
import threading
import time

from websocket import (
    OPCODE_BINARY_INT,
    OPCODE_PING_INT,
    OPCODE_PONG_INT,
    OPCODE_TEXT_INT,
    WebSocketError,
    complete_handshake,
    read_frame,
    write_frame,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Longest room code accepted, in characters.
MAX_ROOM_CODE_LENGTH_INT = 32

#: How long a client has to complete the handshake, in seconds.
HANDSHAKE_TIMEOUT_SECONDS_INT = 10

#: Pending connections the listening socket will hold.
LISTEN_BACKLOG_INT = 64

#: Milliseconds per second, for the clock-probe timestamp.
MILLISECONDS_PER_SECOND_INT = 1000


class Peer:
    """
    One connected device.

    Arguments:
        client_socket (socket.socket): The peer's socket.
        address_tuple (tuple): Its remote address.

    Returns:
        (Peer): The peer record.
    """

    __slots__ = ("client_socket", "address_tuple", "room_code_str")

    def __init__(self, client_socket, address_tuple):
        self.client_socket = client_socket
        self.address_tuple = address_tuple
        self.room_code_str = None


class Relay:
    """
    Room-keyed broadcast hub.

    Brief:
        Membership is guarded by one lock; the broadcast itself happens
        outside it, against a snapshot, so a slow or dead socket cannot hold
        every other room's traffic behind it.

    Arguments:
        (none)

    Returns:
        (Relay): The hub.
    """

    def __init__(self):
        self.rooms_dict = {}
        self.lock_obj = threading.Lock()

    def join(self, room_code_str, peer_obj):
        """
        Add a peer to a room.

        Arguments:
            room_code_str (str): The room to join.
            peer_obj (Peer): The joining peer.

        Returns:
            (int): How many peers are now in the room.
        """
        with self.lock_obj:
            members_set = self.rooms_dict.setdefault(room_code_str, set())
            members_set.add(peer_obj)
            return len(members_set)

    def leave(self, room_code_str, peer_obj):
        """
        Remove a peer, discarding the room once it is empty.

        Arguments:
            room_code_str (str): The room to leave.
            peer_obj (Peer): The departing peer.

        Returns:
            (none)
        """
        with self.lock_obj:
            members_set = self.rooms_dict.get(room_code_str)
            if not members_set:
                return
            members_set.discard(peer_obj)
            if not members_set:
                self.rooms_dict.pop(room_code_str, None)

    def broadcast(self, room_code_str, sender_obj, payload_bytes):
        """
        Forward one payload to every other member of a room.

        Arguments:
            room_code_str (str): The room to broadcast within.
            sender_obj (Peer): The peer to skip.
            payload_bytes (bytes): The payload, forwarded verbatim.

        Returns:
            (none)

        Warning:
            A failed write is swallowed. The peer's own thread will notice
            the dead socket and clean up; failing here would take down a
            broadcast for everyone else.
        """
        with self.lock_obj:
            members_list = list(self.rooms_dict.get(room_code_str, ()))

        for member_obj in members_list:
            if member_obj is sender_obj:
                continue
            try:
                write_frame(member_obj.client_socket, payload_bytes)
            except OSError:
                pass


def handle_join(relay_obj, peer_obj, message_dict):
    """
    Move a peer into the room it asked for.

    Arguments:
        relay_obj (Relay): The hub.
        peer_obj (Peer): The joining peer.
        message_dict (dict): The decoded join message.

    Returns:
        (none)
    """
    room_code_str = str(message_dict.get("room", ""))[
        :MAX_ROOM_CODE_LENGTH_INT
    ]
    if not room_code_str:
        return

    if peer_obj.room_code_str:
        relay_obj.leave(peer_obj.room_code_str, peer_obj)
    peer_obj.room_code_str = room_code_str

    peer_count_int = relay_obj.join(room_code_str, peer_obj)
    write_frame(peer_obj.client_socket, json.dumps({
        "t": "joined", "room": room_code_str, "peers": peer_count_int,
    }).encode())
    relay_obj.broadcast(room_code_str, peer_obj, json.dumps({
        "t": "peer-joined", "peers": peer_count_int,
    }).encode())

    sys.stderr.write(
        f"  relay  {peer_obj.address_tuple[0]} joined room "
        f"{room_code_str} ({peer_count_int} peers)\n"
    )


def handle_clock_probe(peer_obj, message_dict):
    """
    Answer a clock-sync probe with the server's receive time.

    Arguments:
        peer_obj (Peer): The probing peer.
        message_dict (dict): The decoded probe.

    Returns:
        (none)

    Warning:
        Answered immediately and before anything else, because any delay
        added here lands directly in the caller's measured offset.
    """
    write_frame(peer_obj.client_socket, json.dumps({
        "t": "pong",
        "id": message_dict.get("id"),
        "st": time.time() * MILLISECONDS_PER_SECOND_INT,
    }).encode())


def route_payload(relay_obj, peer_obj, payload_bytes):
    """
    Decide what to do with one decoded frame.

    Arguments:
        relay_obj (Relay): The hub.
        peer_obj (Peer): The sending peer.
        payload_bytes (bytes): The frame payload.

    Returns:
        (none)

    Warning:
        Only the envelope's `t` field is read. Anything that is not a join
        or a probe is forwarded without being understood, which is what
        keeps the relay independent of the application's protocol.
    """
    try:
        message_dict = json.loads(payload_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return

    kind_str = message_dict.get("t")
    if kind_str == "join":
        handle_join(relay_obj, peer_obj, message_dict)
    elif kind_str == "ping":
        handle_clock_probe(peer_obj, message_dict)
    elif peer_obj.room_code_str:
        relay_obj.broadcast(
            peer_obj.room_code_str, peer_obj, payload_bytes
        )


def serve_client(client_socket, address_tuple, relay_obj):
    """
    Handle one client for the life of its connection.

    Arguments:
        client_socket (socket.socket): The accepted socket.
        address_tuple (tuple): Its remote address.
        relay_obj (Relay): The hub.

    Returns:
        (none)
    """
    peer_obj = Peer(client_socket, address_tuple)
    try:
        client_socket.settimeout(HANDSHAKE_TIMEOUT_SECONDS_INT)
        if not complete_handshake(client_socket):
            return
        client_socket.settimeout(None)

        while True:
            frame_tuple = read_frame(client_socket)
            if frame_tuple is None:
                break
            opcode_int, payload_bytes = frame_tuple

            if opcode_int == OPCODE_PING_INT:
                write_frame(
                    client_socket, payload_bytes, opcode_int=OPCODE_PONG_INT
                )
                continue
            if opcode_int == OPCODE_PONG_INT:
                continue
            if opcode_int not in (OPCODE_TEXT_INT, OPCODE_BINARY_INT):
                continue

            route_payload(relay_obj, peer_obj, payload_bytes)

    except (OSError, WebSocketError):
        pass
    finally:
        if peer_obj.room_code_str:
            relay_obj.leave(peer_obj.room_code_str, peer_obj)
        try:
            client_socket.close()
        except OSError:
            pass


def run_relay(port_int):
    """
    Listen for relay connections until the process ends.

    Arguments:
        port_int (int): Port to bind.

    Returns:
        (none)

    Warning:
        Binds every interface, which is the point: the relay exists so a
        phone on the same network can reach this machine.
    """
    relay_obj = Relay()
    listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listen_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listen_socket.bind(("0.0.0.0", port_int))
    listen_socket.listen(LISTEN_BACKLOG_INT)

    while True:
        try:
            client_socket, address_tuple = listen_socket.accept()
        except OSError:
            break
        threading.Thread(
            target=serve_client,
            args=(client_socket, address_tuple, relay_obj),
            daemon=True,
        ).start()
