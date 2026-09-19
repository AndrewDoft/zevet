"""Run on electron-builder's mounted staging volume, before final sealing."""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "desktop/node_modules/dmg-builder/vendor"))
from ds_store import DSStore
from mac_alias import Bookmark

mount = Path(sys.argv[1])
backgrounds = list((mount / ".background").glob("*.tiff"))
assert len(backgrounds) == 1, "Expected the branded Retina background"
with tempfile.TemporaryDirectory(prefix="zevet-dmg-bookmark-") as directory:
    bookmark = Path(directory) / "background.bookmark"
    subprocess.run(["swift", str(root / "scripts/dmg-bookmark.swift"), "create", str(backgrounds[0]), str(bookmark)], check=True)
    with DSStore.open(str(mount / ".DS_Store"), "r+") as store:
        store["."]["pBBk"] = Bookmark.from_bytes(bookmark.read_bytes())
