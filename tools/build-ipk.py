#!/usr/bin/env python3
"""Packages the app as a webOS .ipk (an ar archive of debian-binary, control.tar.gz, data.tar.gz).

    build-ipk.py <out.ipk> [--extra path=file ...]

--extra adds files that are not in the source tree (for example a dev-config.js for test builds).
"""
import io
import json
import sys
import tarfile
import time
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
INCLUDE = ["appinfo.json", "index.html", "css", "js", "img"]


def add_bytes(tar, name, data, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = int(time.time())
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    tar.addfile(info, io.BytesIO(data))


def add_dir(tar, name):
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.mtime = int(time.time())
    info.uname = info.gname = "root"
    tar.addfile(info)


def targz(fill):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        fill(tar)
    return buf.getvalue()


def ar_member(name, data):
    header = f"{name:<16}{int(time.time()):<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n".encode()
    assert len(header) == 60
    return header + data + (b"\n" if len(data) % 2 else b"")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    out = Path(args[0])
    extras = {}
    if "--extra" in args:
        for spec in args[args.index("--extra") + 1:]:
            dest, src = spec.split("=", 1)
            extras[dest] = Path(src).read_bytes()

    info = json.loads((APP / "appinfo.json").read_text())
    app_id, version = info["id"], info["version"]
    root = f"./usr/palm/applications/{app_id}"

    def fill_data(tar):
        for d in ["./usr", "./usr/palm", "./usr/palm/applications", root]:
            add_dir(tar, d)
        for item in INCLUDE:
            src = APP / item
            if src.is_dir():
                for path in sorted(src.rglob("*")):
                    rel = path.relative_to(APP).as_posix()
                    if path.is_dir():
                        add_dir(tar, f"{root}/{rel}")
                    elif not path.name.startswith("."):
                        add_bytes(tar, f"{root}/{rel}", path.read_bytes())
            elif src.exists():
                add_bytes(tar, f"{root}/{item}", src.read_bytes())
        for dest, data in extras.items():
            add_bytes(tar, f"{root}/{dest}", data)

    data = targz(fill_data)
    control = (f"Package: {app_id}\nVersion: {version}\nSection: misc\nPriority: optional\n"
               f"Architecture: all\nInstalled-Size: {len(data) // 1024 + 1}\n"
               f"Maintainer: tv-rebuild\nDescription: {info.get('title', app_id)}\nwebOS-Package-Format-Version: 2\n"
               f"webOS-Packager-Version: x.y.x\n")
    ctrl = targz(lambda tar: add_bytes(tar, "./control", control.encode()))

    out.write_bytes(b"!<arch>\n" + ar_member("debian-binary", b"2.0\n")
                    + ar_member("control.tar.gz", ctrl) + ar_member("data.tar.gz", data))
    print(f"built {out} ({app_id} {version}, {out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
