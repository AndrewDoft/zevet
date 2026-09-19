"""Check the mounted deliverable, including Finder's saved install layout.

Uses electron-builder's existing DS_Store reader; no extra dependency.
Called by smoke-macos.mjs after mounting the final DMG.
"""
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "desktop/node_modules/dmg-builder/vendor"))
from ds_store import DSStore

mount = Path(sys.argv[1])
visible = sorted(path.name for path in mount.iterdir() if not path.name.startswith("."))
apps = [name for name in visible if name.endswith(".app")]
assert len(apps) == 1 and visible == sorted([apps[0], "Applications"]), "Installer contains unexpected visible files"
assert (mount / "Applications").is_symlink(), "Applications must be a real install shortcut"
assert (mount / "Applications").readlink() == Path("/Applications")
assert (mount / ".VolumeIcon.icns").is_file(), "Installer volume has no brand icon"

with DSStore.open(str(mount / ".DS_Store"), "r") as store:
    window = store["."]["bwsp"]
    view = store["."]["icvp"]
    locations = [store[name]["Iloc"] for name in [apps[0], "Applications"]]
    background_bookmark = store["."]["pBBk"].to_bytes()

_, _, width, height = map(int, re.findall(r"\d+", window["WindowBounds"]))
assert not window["ShowToolbar"] and not window["ShowSidebar"], "Installer opens with distracting Finder navigation"
assert view["backgroundType"] == 2 and view["arrangeBy"] == "none", "Finder must keep the branded background and drag layout"
assert view["labelOnBottom"] and view["textSize"] >= 12, "Install targets need readable labels"
radius = view["iconSize"] / 2
(app_x, app_y), (destination_x, destination_y) = locations
assert app_x < destination_x and app_y == destination_y, "Install targets must follow the direction of the arrow"
assert destination_x - app_x > 2 * radius + 80, "Install icons overlap the drag cue"
for x, y in locations:
    assert radius + 32 <= x <= width - radius - 32
    assert radius + 110 <= y <= height - radius - 80, "Install icon or label is clipped"

# TIFF contains a standard and Retina image, both at the same physical size.
backgrounds = list((mount / ".background").glob("*.tiff"))
assert len(backgrounds) == 1, "Installer background is missing"
data = backgrounds[0].read_bytes()
assert data[:4] in (b"II\x2a\x00", b"MM\x00\x2a"), "Invalid TIFF background"
order = "<" if data[:2] == b"II" else ">"
offset = struct.unpack_from(order + "I", data, 4)[0]
sizes = []
while offset:
    count = struct.unpack_from(order + "H", data, offset)[0]
    dimensions = {}
    for index in range(count):
        start = offset + 2 + index * 12
        tag, kind, length = struct.unpack_from(order + "HHI", data, start)
        if tag in (256, 257):
            assert length == 1 and kind in (3, 4)
            dimensions[tag] = struct.unpack_from(order + ("H" if kind == 3 else "I"), data, start + 8)[0]
    sizes.append((dimensions[256], dimensions[257]))
    offset = struct.unpack_from(order + "I", data, offset + 2 + count * 12)[0]
assert sizes == [(width, height), (width * 2, height * 2)], f"Background does not match the window at both scales: {sizes}"
with tempfile.TemporaryDirectory(prefix="zevet-dmg-bookmark-check-") as directory:
    bookmark = Path(directory) / "background.bookmark"
    bookmark.write_bytes(background_bookmark)
    subprocess.run(["swift", str(root / "scripts/dmg-bookmark.swift"), "verify", str(backgrounds[0]), str(bookmark)], check=True)
print("Installer layout: only app + Applications, visible drag targets, readable labels, 1x/2x branded background")
