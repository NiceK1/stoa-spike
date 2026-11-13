"""Download selected files from the Stoa preview zip without fetching the whole archive.

    python -I fetch_preview.py dataset questions.jsonl "data/swiss_dwellings/*.dxf"
"""
import argparse
import fnmatch
import io
import os
import urllib.request
import zipfile

URL = ("https://fwjydgxpttajiqpfmqtj.supabase.co/storage/v1/object/public/"
       "stoa-junction-2026/junction-dataset-preview.zip")
BLOCK = 1 << 20


class HttpFile(io.RawIOBase):
    """Seekable read-only view of a URL, backed by cached HTTP range requests."""

    def __init__(self, url):
        self.url = url
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            self.size = int(r.headers["Content-Length"])
        self.pos = 0
        self.blocks = {}

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def _block(self, i):
        if i not in self.blocks:
            start = i * BLOCK
            end = min(start + BLOCK, self.size) - 1
            req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req) as r:
                self.blocks[i] = r.read()
        return self.blocks[i]

    def read(self, n=-1):
        n = self.size - self.pos if n < 0 else min(n, self.size - self.pos)
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, BLOCK)
            chunk = self._block(i)[o:o + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out", help="directory to write into (dataset layout is preserved)")
    p.add_argument("patterns", nargs="+", help='globs relative to the dataset root, e.g. "data/*/LICENSE.md"')
    p.add_argument("--url", default=URL)
    args = p.parse_args()

    out_root = os.path.realpath(args.out)
    z = zipfile.ZipFile(HttpFile(args.url))
    n = size = 0
    for info in z.infolist():
        if info.is_dir() or "/" not in info.filename:
            continue
        rel = info.filename.split("/", 1)[1]
        if not any(fnmatch.fnmatch(rel, pat) for pat in args.patterns):
            continue
        target = os.path.realpath(os.path.join(out_root, rel))
        if not target.startswith(out_root + os.sep):
            raise SystemExit(f"refusing path outside output dir: {info.filename}")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(z.read(info))
        n += 1
        size += info.file_size
    print(f"wrote {n} files, {size / 1e6:.1f} MB, to {out_root}")


if __name__ == "__main__":
    main()
