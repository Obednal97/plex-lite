#!/usr/bin/env python3
"""Packages a Plex Lite external plugin folder as its own webOS .ipk (installable like any app).

    build-plugin-ipk.py <plugin dir> [out.ipk]

The plugin is a normal webOS web app (so Homebrew Channel / dev install can install it) whose
appinfo.json carries a "plexlitePlugin" block. Prints the package's SHA-256 for catalogue pinning.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / 'tools'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ipk = load('build_ipk', 'build-ipk.py')
icons = load('make_icons', 'make-icons.py')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1]).resolve()
    info = json.loads((src / 'appinfo.json').read_text())
    meta = info.get('plexlitePlugin') or {}
    for key in ('id', 'version', 'type', 'main', 'title'):
        if key not in info:
            sys.exit(f'appinfo.json is missing "{key}"')
    if not meta.get('entry') or not (src / meta['entry']).exists():
        sys.exit('appinfo.json plexlitePlugin.entry must name an existing file')
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.parent / f"{info['id']}_{info['version']}_all.ipk"
    root = f"./usr/palm/applications/{info['id']}"

    def fill(tar):
        for d in ['./usr', './usr/palm', './usr/palm/applications', root]:
            ipk.add_dir(tar, d)
        for path in sorted(src.rglob('*')):
            rel = path.relative_to(src).as_posix()
            if path.is_dir():
                ipk.add_dir(tar, f'{root}/{rel}')
            elif not path.name.startswith('.') and path.suffix != '.ipk':
                ipk.add_bytes(tar, f'{root}/{rel}', path.read_bytes())
        if not (src / info.get('icon', 'icon.png')).exists():
            ipk.add_bytes(tar, f"{root}/{info.get('icon', 'icon.png')}", icons.render(80))

    data = ipk.targz(fill)
    control = (f"Package: {info['id']}\nVersion: {info['version']}\nSection: misc\nPriority: optional\n"
               f"Architecture: all\nInstalled-Size: {len(data) // 1024 + 1}\nMaintainer: {info.get('vendor', 'unknown')}\n"
               f"Description: {info['title']} (Plex Lite plugin)\nwebOS-Package-Format-Version: 2\nwebOS-Packager-Version: x.y.x\n")
    ctrl = ipk.targz(lambda tar: ipk.add_bytes(tar, './control', control.encode()))
    blob = b'!<arch>\n' + ipk.ar_member('debian-binary', b'2.0\n') + ipk.ar_member('control.tar.gz', ctrl) + ipk.ar_member('data.tar.gz', data)
    out.write_bytes(blob)
    entry_hash = hashlib.sha256((src / meta['entry']).read_bytes()).hexdigest()
    print(f"built {out} ({len(blob) // 1024} KB)")
    print(f"ipk sha256:   {hashlib.sha256(blob).hexdigest()}")
    print(f"entry sha256: {entry_hash}  (pin this in a catalogue entry)")


if __name__ == '__main__':
    main()
