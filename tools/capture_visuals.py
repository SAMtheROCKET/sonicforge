#!/usr/bin/env python3
"""
Capture the README screenshots and animations from the running application.

Brief:
    Headless Chrome renders one frame per invocation under a fixed virtual
    clock, so a sequence of runs with an advancing budget produces a
    deterministic animation. That determinism is the point: identical
    budgets give identical frames, which is what makes a seamless loop
    possible at all, and what makes a regenerated asset comparable with the
    one it replaces.

    Every scenario stages the interface through the application's own public
    methods. Nothing is drawn that the application would not draw by itself;
    the staging only decides what is on screen and how it is framed.

Warning:
    The three views that read the live analyser -- the 3D spectrogram, the
    goniometer and the stereo meters -- cannot be captured this way. Headless
    Chrome has no audio device, so every analyser bin reads zero and those
    views render empty. They need a real browser session and a screen
    recorder. The interference field is computed analytically from each
    channel's own parameters, which is why it is the one view that is
    correct without a sound card.

Usage:
    python tools/serve.py &                        # something must serve it
    python tools/capture_visuals.py demo
    python tools/capture_visuals.py --all
    python tools/capture_visuals.py phase-null --frames 16 --step-ms 250
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - dependency is optional
    print("This tool needs Pillow:  python -m pip install Pillow")
    sys.exit(1)

REPOSITORY_ROOT_OBJ = Path(__file__).resolve().parent.parent

#: Checked in order; the first that exists wins. SONICFORGE_CHROME overrides.
CHROME_CANDIDATES_TUPLE = (
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
)

DEFAULT_ORIGIN_STR = "http://localhost:8080"

#: Virtual time allowed before the first frame, per scenario weight. The
#: whole-application scenarios have far more to lay out and paint than a
#: single panel does, and a frame taken before that settles shows a readout
#: that has not caught up with the render beside it.
SETTLE_LIGHT_MS_INT = 6000
SETTLE_HEAVY_MS_INT = 9000

#: Colours in the shared palette. The interface is near-monochrome cyan and
#: violet on near-black, so this is visually lossless here.
PALETTE_SIZE_INT = 64

#: How often the staged page repaints the status HUD, in milliseconds.
HUD_REPAINT_MS_INT = 4

#: Seconds before a single frame's render is abandoned.
FRAME_TIMEOUT_SECONDS_INT = 240

#: Staging shared by every scenario that shows the interference field.
FIELD_ONLY_SETUP_STR = """
            app.setVizMode('interference');
            // Field only. The goniometer reads the live analyser, which is
            // silent here, so it would render as an empty dial -- which is
            // exactly the defect the previous generation of these images
            // shipped with.
            app.ui.interference.setDisplayMode('field');
"""

#: Staging that fills the viewport with the interference panel, so that the
#: trace is legible at the size these animations are displayed.
FULL_VIEWPORT_SETUP_STR = """
            const panel = document
              .getElementById('viz-interference').closest('.panel');
            Object.assign(panel.style, {
              position: 'fixed', inset: '0', zIndex: '9999',
              width: '100vw', height: '100vh', borderRadius: '0',
            });
            window.dispatchEvent(new Event('resize'));
"""

SCENARIOS_DICT = {
    "interference": {
        "window": (900, 340),
        "scale": None,
        "settle_ms": SETTLE_LIGHT_MS_INT,
        "frames": 20,
        "step_ms": 50,
        "output": "interference.gif",
        "setup": """
            const rack = app.rack;
            // 60 against 64 Hz, not 440 against 444. Both beat at 4 Hz, but
            // 440 Hz puts 275 cycles across this window and renders as a
            // solid block; at 60 Hz the individual cycles stay legible.
            for (const [index, hertz, pan] of [[0, 60, -0.55],
                                               [1, 64, 0.55]]) {
              const channel = rack.getChannel(index);
              channel.setWaveformName('sine');
              channel.setFrequencyHertz(hertz);
              channel.setGainDb(-4);
              channel.setPanPosition(pan);
              channel.setPhaseDegrees(0);
              channel.start();
            }
        """,
    },
    "phase-null": {
        "window": (900, 340),
        "scale": None,
        "settle_ms": SETTLE_LIGHT_MS_INT,
        "frames": 16,
        "step_ms": 250,
        "output": "phase-null.gif",
        "setup": """
            const rack = app.rack;
            for (const index of [0, 1]) {
              const channel = rack.getChannel(index);
              channel.setWaveformName('sine');
              channel.setFrequencyHertz(60);
              channel.setGainDb(-4);
              channel.setPanPosition(index === 0 ? -0.5 : 0.5);
              channel.start();
            }
            // This frame's offset arrives in the query string and is applied
            // once. Animating it from requestAnimationFrame made the sweep
            // erratic: a virtual clock fires animation frames at
            // unpredictable intervals, so each capture caught whatever the
            // last callback happened to set.
            const phase_degrees =
              Number(new URLSearchParams(location.search).get('phase') ?? 0);
            rack.getChannel(1).setPhaseDegrees(phase_degrees);
        """,
    },
    "demo": {
        "window": (1600, 940),
        "scale": (1200, 705),
        "settle_ms": SETTLE_HEAVY_MS_INT,
        "frames": 20,
        "step_ms": 50,
        "output": "demo.gif",
        "setup": """
            const rack = app.rack;
            // 440 against 444 puts a 4 Hz beat on screen, which makes the
            // field auto-select a 625 ms window and draw a legible envelope.
            // A chord of unrelated partials renders as a dense composite
            // that reads as noise at panel size.
            const plan = [
              [0, 440, 'sine', -13, -0.4, 0],
              [1, 444, 'sine', -13, 0.4, 0],
              [2, 220, 'triangle', -20, 0.0, 90],
              [3, 660, 'sawtooth', -24, -0.2, 180],
            ];
            for (const [index, hertz, wave, db, pan, deg] of plan) {
              const channel = rack.getChannel(index);
              channel.setWaveformName(wave);
              channel.setFrequencyHertz(hertz);
              channel.setGainDb(db);
              channel.setPanPosition(pan);
              channel.setPhaseDegrees(deg);
              channel.start();
            }
            app.selectChannel(0);
        """,
    },
}

#: The stills want the demo's staging at the size they are cut from, so they
#: are derived rather than copied and the setup cannot drift between them.
SCENARIOS_DICT["still"] = {
    **SCENARIOS_DICT["demo"],
    "window": (1720, 940),
    "scale": None,
    "frames": 1,
    "output": "screenshot.png",
}

#: Measured off the gallery image these replace, so a regenerated one drops
#: into the same slot unchanged.
GALLERY_CANVAS_TUPLE = (1270, 760)
GALLERY_GROUND_TUPLE = (11, 15, 25)
GALLERY_INSET_X_INT = 26


def find_chrome(explicit_path_str):
    """
    Locate a Chrome or Chromium binary.

    Arguments:
        explicit_path_str (str|None): Path given on the command line.

    Returns:
        (str): Path to the browser binary.

    Warning:
        Exits the process when none is found, because every later step
        depends on it and a clear message here beats a stack trace later.
    """
    candidates_list = []
    if explicit_path_str:
        candidates_list.append(explicit_path_str)
    if os.environ.get("SONICFORGE_CHROME"):
        candidates_list.append(os.environ["SONICFORGE_CHROME"])
    candidates_list.extend(CHROME_CANDIDATES_TUPLE)

    for candidate_str in candidates_list:
        if Path(candidate_str).exists():
            return candidate_str

    print("No Chrome or Chromium found. Pass --chrome or set")
    print("SONICFORGE_CHROME to the browser binary.")
    sys.exit(1)


def build_staged_page(scenario_str):
    """
    Write a temporary copy of the page that boots and stages one scenario.

    Brief:
        The staging is appended to a copy of index.html rather than injected
        at runtime, so the page loads exactly as a visitor's would, with the
        same module graph and the same boot order.

    Arguments:
        scenario_str (str): Key into SCENARIOS_DICT.

    Returns:
        (str): The page's file name, relative to the repository root.

    Warning:
        Writes into the repository root and is removed when the run ends.
        Two captures cannot run at once: the second would delete the first's
        page out from under it, and the first would then screenshot a 404.
    """
    spec_dict = SCENARIOS_DICT[scenario_str]
    setup_str = spec_dict["setup"]
    if scenario_str != "waterfall":
        setup_str += FIELD_ONLY_SETUP_STR
    if spec_dict["scale"] is None and spec_dict["frames"] > 1:
        setup_str += FULL_VIEWPORT_SETUP_STR

    staging_str = f"""
<script type="module">
import {{ buildHudMarkup }} from './js/app/frame-loop.js';
await new Promise((resolve) => setTimeout(resolve, 400));
document.getElementById('unlock')?.click();
await new Promise((resolve) => setTimeout(resolve, 900));
const app = window.SonicForge;
{setup_str}
await new Promise((resolve) => setTimeout(resolve, 300));
// The application rewrites this readout on every third animation frame.
// Under a virtual clock the visualiser's loop and the frame loop interleave
// unpredictably, so a screenshot can catch HUD text written before the
// render beside it -- four frames in twenty read "VOICES 0" next to a live
// trace. This repaints the same string, from the same exported builder
// against the same live state, on a timer instead: virtual time pumps timers
// eagerly while animation frames stay tied to the compositor. It changes
// when the readout is written, never what it says.
const hud_el = document.getElementById('viz-hud');
setInterval(() => {{
  hud_el.innerHTML = buildHudMarkup(app, -12);
}}, {HUD_REPAINT_MS_INT});
</script>
"""
    page_name_str = f"__capture-{scenario_str}.html"
    source_str = (REPOSITORY_ROOT_OBJ / "index.html").read_text(
        encoding="utf-8"
    )
    (REPOSITORY_ROOT_OBJ / page_name_str).write_text(
        source_str.replace("</body>", staging_str + "</body>"),
        encoding="utf-8",
    )
    return page_name_str


def build_frame_query(scenario_str, frame_index_int, frame_count_int):
    """
    Build the query string that distinguishes this frame from its siblings.

    Brief:
        Only the phase sweep varies per frame. One cosine across the whole
        run means the first and last frames sit at the same offset, so the
        animation closes without a seam.

    Arguments:
        scenario_str (str): Key into SCENARIOS_DICT.
        frame_index_int (int): Zero-based frame number.
        frame_count_int (int): Total frames in this run.

    Returns:
        (str): Query string including the leading "?", or "" when the
        scenario stages every frame identically.
    """
    if scenario_str != "phase-null":
        return ""

    turn_float = 2 * math.pi * frame_index_int / frame_count_int
    degrees_int = round(90 + 90 * math.cos(turn_float))
    return f"?phase={degrees_int}"


def shoot_frame(options_dict):
    """
    Render one frame at a fixed virtual time.

    Arguments:
        options_dict (dict): chrome_str, page_name_str, origin_str,
            window_tuple, budget_ms_int, query_str and output_path_obj.

    Returns:
        (bool): True when a frame was produced.

    Warning:
        A profile directory is created and removed per frame. Sharing one
        would let a previous frame's stored state leak into the next, which
        is exactly the determinism this tool depends on.
    """
    profile_str = tempfile.mkdtemp()
    url_str = (
        f"{options_dict['origin_str']}/{options_dict['page_name_str']}"
        f"{options_dict['query_str']}"
    )
    try:
        subprocess.run(
            [
                options_dict["chrome_str"],
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--mute-audio",
                "--autoplay-policy=no-user-gesture-required",
                "--enable-unsafe-swiftshader",
                "--hide-scrollbars",
                f"--user-data-dir={profile_str}",
                "--window-size="
                f"{options_dict['window_tuple'][0]},"
                f"{options_dict['window_tuple'][1]}",
                f"--virtual-time-budget={options_dict['budget_ms_int']}",
                f"--screenshot={options_dict['output_path_obj']}",
                url_str,
            ],
            capture_output=True,
            timeout=FRAME_TIMEOUT_SECONDS_INT,
        )
    except subprocess.TimeoutExpired:
        return False
    finally:
        shutil.rmtree(profile_str, ignore_errors=True)

    return options_dict["output_path_obj"].exists()


def write_animation(images_list, output_path_obj, step_ms_int):
    """
    Encode frames into an animated GIF.

    Brief:
        One shared palette for every frame. Quantising each frame separately
        gives each its own palette, which both flickers and defeats the
        encoder's frame differencing, forcing every frame to be stored
        whole. A single palette with disposal=1 lets it store only what
        moved -- on the whole-application animation that is the difference
        between 1955 KB and 542 KB.

    Arguments:
        images_list (list[Image]): Frames, in order.
        output_path_obj (Path): Where to write the GIF.
        step_ms_int (int): Milliseconds per frame.

    Returns:
        (none)
    """
    palette_obj = images_list[0].quantize(
        colors=PALETTE_SIZE_INT, method=Image.MEDIANCUT
    )
    quantised_list = [
        image_obj.quantize(palette=palette_obj, dither=Image.NONE)
        for image_obj in images_list
    ]
    quantised_list[0].save(
        output_path_obj,
        save_all=True,
        append_images=quantised_list[1:],
        duration=step_ms_int,
        loop=0,
        optimize=True,
        disposal=1,
    )


def build_gallery_image(source_obj):
    """
    Inset a screenshot on the gallery ground colour.

    Arguments:
        source_obj (Image): The full-size capture.

    Returns:
        (Image): Gallery image at the canvas size.
    """
    inner_width_int = GALLERY_CANVAS_TUPLE[0] - 2 * GALLERY_INSET_X_INT
    inner_height_int = round(
        inner_width_int * source_obj.size[1] / source_obj.size[0]
    )
    scaled_obj = source_obj.resize(
        (inner_width_int, inner_height_int), Image.LANCZOS
    )
    canvas_obj = Image.new("RGB", GALLERY_CANVAS_TUPLE, GALLERY_GROUND_TUPLE)
    canvas_obj.paste(
        scaled_obj,
        (
            GALLERY_INSET_X_INT,
            (GALLERY_CANVAS_TUPLE[1] - inner_height_int) // 2,
        ),
    )
    return canvas_obj


def capture_scenario(scenario_str, arguments_obj):
    """
    Capture one scenario and write its deliverable into assets.

    Arguments:
        scenario_str (str): Key into SCENARIOS_DICT.
        arguments_obj (Namespace): Parsed command line.

    Returns:
        (bool): True when the deliverable was written.
    """
    spec_dict = SCENARIOS_DICT[scenario_str]
    frame_count_int = arguments_obj.frames or spec_dict["frames"]
    step_ms_int = arguments_obj.step_ms or spec_dict["step_ms"]
    settle_ms_int = arguments_obj.settle_ms or spec_dict["settle_ms"]

    page_name_str = build_staged_page(scenario_str)
    frames_dir_obj = Path(tempfile.gettempdir(), f"sonicforge-{scenario_str}")
    frames_dir_obj.mkdir(exist_ok=True)
    images_list = []

    try:
        for frame_index_int in range(frame_count_int):
            frame_path_obj = frames_dir_obj / f"{frame_index_int:03d}.png"
            frame_path_obj.unlink(missing_ok=True)
            produced_bool = shoot_frame({
                "chrome_str": arguments_obj.chrome_path_str,
                "page_name_str": page_name_str,
                "origin_str": arguments_obj.origin,
                "window_tuple": spec_dict["window"],
                "budget_ms_int": settle_ms_int
                + frame_index_int * step_ms_int,
                "query_str": build_frame_query(
                    scenario_str, frame_index_int, frame_count_int
                ),
                "output_path_obj": frame_path_obj,
            })
            if not produced_bool:
                print(f"  frame {frame_index_int} failed")
                continue

            image_obj = Image.open(frame_path_obj).convert("RGB")
            if spec_dict["scale"]:
                image_obj = image_obj.resize(
                    spec_dict["scale"], Image.LANCZOS
                )
            images_list.append(image_obj)
            print(
                f"  frame {frame_index_int + 1}/{frame_count_int}", flush=True
            )
    finally:
        (REPOSITORY_ROOT_OBJ / page_name_str).unlink(missing_ok=True)

    return write_deliverables(scenario_str, images_list, step_ms_int)


def write_deliverables(scenario_str, images_list, step_ms_int):
    """
    Write the asset or assets a finished capture produces.

    Arguments:
        scenario_str (str): Key into SCENARIOS_DICT.
        images_list (list[Image]): Captured frames, in order.
        step_ms_int (int): Milliseconds per frame.

    Returns:
        (bool): True when something was written.
    """
    if not images_list:
        print(f"  {scenario_str}: no frames captured")
        return False

    assets_dir_obj = REPOSITORY_ROOT_OBJ / "assets"
    output_path_obj = assets_dir_obj / SCENARIOS_DICT[scenario_str]["output"]

    if len(images_list) == 1:
        images_list[0].save(output_path_obj, optimize=True)
        written_list = [output_path_obj]
        if scenario_str == "still":
            gallery_path_obj = assets_dir_obj / "ph-gallery.png"
            build_gallery_image(images_list[0]).save(
                gallery_path_obj, optimize=True
            )
            written_list.append(gallery_path_obj)
    else:
        write_animation(images_list, output_path_obj, step_ms_int)
        written_list = [output_path_obj]

    for path_obj in written_list:
        with Image.open(path_obj) as image_obj:
            size_tuple = image_obj.size
        print(
            f"  {path_obj.name}  {size_tuple[0]}x{size_tuple[1]}  "
            f"{len(images_list)} frame(s)  "
            f"{path_obj.stat().st_size // 1024} KB"
        )
    return True


def parse_arguments():
    """
    Parse the command line.

    Arguments:
        (none)

    Returns:
        (Namespace): Parsed arguments, with chrome_path_str resolved.
    """
    parser_obj = argparse.ArgumentParser(
        description="Capture README visuals from the running application."
    )
    parser_obj.add_argument(
        "scenario", nargs="?", choices=sorted(SCENARIOS_DICT),
        help="Which visual to capture."
    )
    parser_obj.add_argument(
        "--all", action="store_true", help="Capture every scenario."
    )
    parser_obj.add_argument(
        "--origin", default=DEFAULT_ORIGIN_STR,
        help=f"Where the application is served (default {DEFAULT_ORIGIN_STR})."
    )
    parser_obj.add_argument("--frames", type=int, help="Override frame count.")
    parser_obj.add_argument(
        "--step-ms", type=int, dest="step_ms", help="Override frame interval."
    )
    parser_obj.add_argument(
        "--settle-ms", type=int, dest="settle_ms",
        help="Override the virtual time allowed before the first frame."
    )
    parser_obj.add_argument("--chrome", help="Path to the browser binary.")

    arguments_obj = parser_obj.parse_args()
    if not arguments_obj.scenario and not arguments_obj.all:
        parser_obj.error("name a scenario, or pass --all")
    arguments_obj.chrome_path_str = find_chrome(arguments_obj.chrome)
    return arguments_obj


def main():
    """Capture the requested scenarios."""
    arguments_obj = parse_arguments()
    targets_list = (
        sorted(SCENARIOS_DICT) if arguments_obj.all
        else [arguments_obj.scenario]
    )

    for scenario_str in targets_list:
        print(f"{scenario_str}:")
        if not capture_scenario(scenario_str, arguments_obj):
            sys.exit(1)


if __name__ == "__main__":
    main()
