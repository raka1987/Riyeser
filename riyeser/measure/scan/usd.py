"""Universal Scene Description: .usdz (a zip), .usdc (binary "crate") and .usda (text) -> Scene.

Apple RoomPlan's export (and the iPhone apps built on it) is a USDZ holding one USDC layer. Its rooms are
"parametric": every wall, door, window and opening is its own prim (Wall0, Door0, Window1, Opening0 ...) holding a
box mesh, so the names and boxes give the real sizes (roomplan.py reads them). Other USDZ files (Polycam, Magicplan,
3D Scanner apps) hold a scanned mesh, which planes.py measures.

The crate reader follows the published file layout of Pixar's OpenUSD (crateFile.cpp: bootstrap, table of contents,
TOKENS / STRINGS / FIELDS / FIELDSETS / PATHS / SPECS sections; LZ4 "TfFastCompression"; the integer coding of
Usd_IntegerCompression). It reads what geometry needs (meshes, cubes, transforms, the layer's upAxis and
metersPerUnit) for crate versions 0.4 and later, and skips anything else. Only prims in the file itself are read:
references to other files, variants and time samples are not followed.
"""
import io
import re
import struct
import zipfile
from array import array

from .meshes import IDENTITY, Part, Scene, ScanError, mat_mul, mat_trs, mat_axis_angle, transform


# ---------------------------------------------------------------- LZ4 block format (pure Python)
def lz4_block(src, max_out=None):
    out = bytearray()
    i, n = 0, len(src)
    while i < n:
        tok = src[i]
        i += 1
        lit = tok >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += src[i: i + lit]
        i += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = tok & 15
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        if off == 0 or off > len(out):
            raise ScanError("The USD file's compressed data is damaged.")
        start = len(out) - off
        if ml <= off:
            out += out[start: start + ml]
        else:
            for k in range(ml):
                out.append(out[start + k])
        if max_out and len(out) > max_out:
            raise ScanError("The USD file's compressed data is damaged.")
    return bytes(out)


def fast_decompress(buf):
    """TfFastCompression: a chunk count byte, then one LZ4 block (count 0) or that many (int32 size, block) chunks."""
    if not buf:
        return b""
    n = buf[0]
    if n == 0:
        return lz4_block(buf[1:])
    out, off = [], 1
    for _ in range(n):
        size = struct.unpack_from("<i", buf, off)[0]
        off += 4
        out.append(lz4_block(buf[off: off + size]))
        off += size
    return b"".join(out)


def decode_ints(data, count, bits=32):
    """Usd_IntegerCompression's coding (after LZ4): a common delta, 2-bit codes, then the other deltas."""
    sfx = {32: ("i", 4, (("b", 1), ("h", 2), ("i", 4))), 64: ("q", 8, (("h", 2), ("i", 4), ("q", 8)))}[bits]
    common = struct.unpack_from("<" + sfx[0], data, 0)[0]
    codes_at = sfx[1]
    vals_at = codes_at + (count * 2 + 7) // 8
    out = [0] * count
    prev = 0
    sizes = sfx[2]
    for i in range(count):
        code = (data[codes_at + i // 4] >> (2 * (i % 4))) & 3
        if code == 0:
            prev += common
        else:
            fmt, size = sizes[code - 1]
            prev += struct.unpack_from("<" + fmt, data, vals_at)[0]
            vals_at += size
        out[i] = prev
    return out


# ---------------------------------------------------------------- the crate (.usdc)
SPECIFIER = {0: "def", 1: "over", 2: "class"}
_SCALAR = {1: ("?", 1), 2: ("B", 1), 3: ("i", 4), 4: ("I", 4), 5: ("q", 8), 6: ("Q", 8), 7: ("e", 2), 8: ("f", 4),
           9: ("d", 8)}
_VEC = {19: ("d", 2), 20: ("f", 2), 21: ("e", 2), 22: ("i", 2), 23: ("d", 3), 24: ("f", 3), 25: ("e", 3), 26: ("i", 3),
        27: ("d", 4), 28: ("f", 4), 29: ("e", 4), 30: ("i", 4), 16: ("d", 4), 17: ("f", 4), 18: ("e", 4),
        13: ("d", 4), 14: ("d", 9), 15: ("d", 16)}
QUATS = (16, 17, 18)
MATRICES = {13: 2, 14: 3, 15: 4}


class Crate:
    def __init__(self, data):
        if data[:8] != b"PXR-USDC":
            raise ScanError("That isn't a USD crate file.")
        self.d = data
        self.ver = tuple(data[8:11])
        if self.ver < (0, 4, 0):
            raise ScanError("This USD file is from a very old version of USD. Open it in a newer app and export again.")
        toc = struct.unpack_from("<q", data, 16)[0]
        nsec = struct.unpack_from("<Q", data, toc)[0]
        self.sections = {}
        for k in range(nsec):
            name, start, size = struct.unpack_from("<16sqq", data, toc + 8 + 32 * k)
            self.sections[name.split(b"\0")[0].decode()] = (start, size)
        self._tokens()
        self._strings()
        self._fields()
        self._fieldsets()
        self._paths()
        self._specs()

    # --- reading helpers
    def _u64(self, off):
        return struct.unpack_from("<Q", self.d, off)[0]

    def _ints(self, off, count, bits=32):
        """Compressed ints at off: (values, next offset)."""
        size = self._u64(off)
        raw = fast_decompress(self.d[off + 8: off + 8 + size])
        return (decode_ints(raw, count, bits) if count else []), off + 8 + size

    def _tokens(self):
        off = self.sections["TOKENS"][0]
        n, _usize, csize = struct.unpack_from("<QQQ", self.d, off)
        raw = fast_decompress(self.d[off + 24: off + 24 + csize])
        self.tokens = raw.split(b"\0")[:n]
        self.tokens = [t.decode("utf-8", "replace") for t in self.tokens]

    def _strings(self):
        sec = self.sections.get("STRINGS")
        self.strings = []
        if sec:
            n = self._u64(sec[0])
            self.strings = list(struct.unpack_from(f"<{n}I", self.d, sec[0] + 8))

    def _fields(self):
        off = self.sections["FIELDS"][0]
        n = self._u64(off)
        toks, off = self._ints(off + 8, n)
        size = self._u64(off)
        reps = fast_decompress(self.d[off + 8: off + 8 + size])
        self.fields = [(self.tokens[toks[i]], struct.unpack_from("<Q", reps, 8 * i)[0]) for i in range(n)]

    def _fieldsets(self):
        off = self.sections["FIELDSETS"][0]
        n = self._u64(off)
        vals, _ = self._ints(off + 8, n)
        self.fieldsets, cur, start = {}, [], 0
        for i, v in enumerate(vals):
            if v == 0xFFFFFFFF or v == -1:
                self.fieldsets[start] = cur
                cur, start = [], i + 1
            else:
                cur.append(v)

    def _paths(self):
        off = self.sections["PATHS"][0]
        n = self._u64(off)
        nenc = self._u64(off + 8)
        idx, o = self._ints(off + 16, nenc)
        elem, o = self._ints(o, nenc)
        jumps, o = self._ints(o, nenc)
        elem = [e - (1 << 32) if e >= 1 << 31 else e for e in elem]
        jumps = [j - (1 << 32) if j >= 1 << 31 else j for j in jumps]
        self.paths = [""] * n
        stack = [(0, None)]
        while stack:          # iterative form of crateFile.cpp's _BuildDecompressedPathsImpl
            cur, parent = stack.pop()
            while True:
                this = cur
                cur += 1
                if parent is None:
                    path = "/"
                    parent = "/"
                else:
                    t = elem[this]
                    tok = self.tokens[abs(t)]
                    path = (parent + "." + tok) if t < 0 else (parent.rstrip("/") + "/" + tok)
                self.paths[idx[this]] = path
                j = jumps[this]
                has_child, has_sib = j > 0 or j == -1, j >= 0
                if has_child:
                    if has_sib:
                        stack.append((this + j, parent))
                    parent = path
                elif not has_sib:
                    break
                if not (has_child or has_sib):
                    break

    def _specs(self):
        off = self.sections["SPECS"][0]
        n = self._u64(off)
        paths, o = self._ints(off + 8, n)
        fsets, o = self._ints(o, n)
        types, o = self._ints(o, n)
        self.specs = list(zip(paths, fsets, types))

    # --- values
    def value(self, rep):
        is_array = bool(rep >> 63 & 1)
        inline = bool(rep >> 62 & 1)
        compressed = bool(rep >> 61 & 1)
        t = (rep >> 48) & 0xFF
        payload = rep & ((1 << 48) - 1)
        d = self.d
        if is_array:
            if payload == 0:
                return []
            off = payload
            if self.ver >= (0, 7, 0):
                count = self._u64(off)
                off += 8
            else:
                count = struct.unpack_from("<I", d, off)[0]
                off += 4
            if t in (3, 4, 5, 6) and compressed:
                return self._ints(off, count, 64 if t in (5, 6) else 32)[0]
            if t in (7, 8, 9) and compressed:
                code = d[off:off + 1]
                if code == b"i":
                    return [float(v) for v in self._ints(off + 1, count)[0]]
                if code == b"t":
                    lsize = struct.unpack_from("<I", d, off + 1)[0]
                    fmt, size = _SCALAR[t]
                    lut = struct.unpack_from(f"<{lsize}{fmt}", d, off + 5)
                    ids = self._ints(off + 5 + lsize * size, count)[0]
                    return [float(lut[i]) for i in ids]
                return []
            if t in _SCALAR:
                fmt, size = _SCALAR[t]
                return list(struct.unpack_from(f"<{count}{fmt}", d, off))
            if t in _VEC:
                fmt, nc = _VEC[t]
                flat = struct.unpack_from(f"<{count * nc}{fmt}", d, off)
                return [tuple(flat[i * nc:(i + 1) * nc]) for i in range(count)]
            if t == 11:
                ids = struct.unpack_from(f"<{count}I", d, off)
                return [self.tokens[i] for i in ids]
            return None
        if inline:
            p32 = payload & 0xFFFFFFFF
            if t == 1:
                return bool(payload)
            if t in (3, 4, 42, 43, 44):
                v = struct.unpack("<i", struct.pack("<I", p32))[0]
                return SPECIFIER.get(v, v) if t == 42 else v
            if t in (5, 6):
                return payload
            if t == 8 or t == 9:
                return struct.unpack("<f", struct.pack("<I", p32))[0]
            if t == 11:
                return self.tokens[p32] if p32 < len(self.tokens) else ""
            if t == 10:
                return self.tokens[self.strings[p32]] if p32 < len(self.strings) else ""
            if t in _VEC and t not in MATRICES:
                nc = _VEC[t][1]
                b = struct.pack("<Q", payload)
                return tuple(float(x) for x in struct.unpack_from(f"<{nc}b", b, 0))
            if t in MATRICES:     # a diagonal matrix, its diagonal as int8s
                k = MATRICES[t]
                b = struct.pack("<Q", payload)
                diag = struct.unpack_from(f"<{k}b", b, 0)
                return tuple(float(diag[r]) if r == c else 0.0 for r in range(k) for c in range(k))
            return None
        off = payload
        if t in _SCALAR:
            fmt, _ = _SCALAR[t]
            return struct.unpack_from("<" + fmt, d, off)[0]
        if t in _VEC:
            fmt, nc = _VEC[t]
            return tuple(struct.unpack_from(f"<{nc}{fmt}", d, off))
        if t == 41:    # TokenVector
            count = self._u64(off)
            return [self.tokens[i] for i in struct.unpack_from(f"<{count}I", d, off + 8)]
        return None

    def layer(self):
        """{'meta': {...}, 'prims': {path: {'type', 'spec', 'attrs': {name: value}}}}"""
        prims, meta = {}, {}
        attrs = []
        for pi, fs, st in self.specs:
            path = self.paths[pi] if pi < len(self.paths) else ""
            fields = {}
            for fi in self.fieldsets.get(fs, []):
                name, rep = self.fields[fi]
                if name in ("typeName", "specifier", "default", "metersPerUnit", "upAxis", "size"):
                    try:
                        fields[name] = self.value(rep)
                    except (struct.error, IndexError, ScanError):
                        fields[name] = None
            if st == 7:
                meta = {k: v for k, v in fields.items() if k in ("metersPerUnit", "upAxis")}
            elif st == 6:
                prims[path] = {"type": fields.get("typeName") or "", "spec": fields.get("specifier") or "def", "attrs": {}}
            elif st == 1:
                attrs.append((path, fields.get("default")))
        for path, v in attrs:
            prim, _, name = path.rpartition(".")
            if prim in prims and v is not None:
                prims[prim]["attrs"][name] = v
        return {"meta": meta, "prims": prims}


# ---------------------------------------------------------------- text (.usda)
_TOK = re.compile(r'\s+|#[^\n]*|"""(?:.|\n)*?"""|\'\'\'(?:.|\n)*?\'\'\'|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|@[^@]*@'
                  r'|<[^>]*>|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_][\w:.]*|\[\]|[()\[\]{}=,;&]')


def _tokens(text):
    out = []
    for m in _TOK.finditer(text):
        s = m.group()
        if s[0].isspace() or s[0] == "#":
            continue
        out.append(s)
    return out


def _skip(tk, i):
    """Skip a balanced (...) [...] {...} group starting at tk[i]."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = [pairs[tk[i]]]
    i += 1
    while stack and i < len(tk):
        t = tk[i]
        if t in pairs:
            stack.append(pairs[t])
        elif t == stack[-1]:
            stack.pop()
        i += 1
    return i


def _value(tk, i):
    t = tk[i]
    if t in ("(", "["):
        close = ")" if t == "(" else "]"
        items = []
        i += 1
        while i < len(tk) and tk[i] != close:
            if tk[i] == ",":
                i += 1
                continue
            v, i = _value(tk, i)
            items.append(v)
        return (tuple(items) if t == "(" else items), i + 1
    if t == "{":
        return None, _skip(tk, i)
    if t[0] in "\"'":
        return t.strip("\"'"), i + 1
    try:
        return float(t), i + 1
    except ValueError:
        return t, i + 1


def parse_usda(text):
    tk = _tokens(text)
    prims, meta = {}, {}
    i = 0
    if tk and tk[0] == "(":
        j, end = 1, _skip(tk, 0) - 1
        while j < end:
            if tk[j] in ("metersPerUnit", "upAxis") and tk[j + 1] == "=":
                key = tk[j]
                meta[key], j = _value(tk, j + 2)
            else:
                j += 1
        i = end + 1

    def body(i, parent):
        while i < len(tk) and tk[i] != "}":
            t = tk[i]
            if t in ("def", "over", "class"):
                spec = t
                i += 1
                typ = ""
                if tk[i][0] not in "\"'":
                    typ = tk[i]
                    i += 1
                name = tk[i].strip("\"'")
                i += 1
                if i < len(tk) and tk[i] == "(":
                    i = _skip(tk, i)
                path = parent.rstrip("/") + "/" + name
                prims[path] = {"type": typ, "spec": spec, "attrs": {}}
                if i < len(tk) and tk[i] == "{":
                    i = body(i + 1, path) + 1
            elif t in ("variantSet",):
                while i < len(tk) and tk[i] != "{":
                    i += 1
                i = _skip(tk, i)
            elif t in ("reorder", "rel"):
                i += 2
                if i < len(tk) and tk[i] == "=":
                    _v, i = _value(tk, i + 1)
            elif t in ("(", "[", "{"):
                i = _skip(tk, i)
            else:   # [custom] [uniform|varying|config] type[[]] name [= value] [(meta)]
                while tk[i] in ("custom", "uniform", "varying", "config", "prepend", "append", "delete", "add"):
                    i += 1
                i += 1                                # type
                if i < len(tk) and tk[i] == "[]":
                    i += 1
                name = tk[i] if i < len(tk) else ""
                i += 1
                val = None
                if i < len(tk) and tk[i] == "=":
                    val, i = _value(tk, i + 1)
                if i < len(tk) and tk[i] == "(":
                    i = _skip(tk, i)
                if parent in prims and val is not None and not name.endswith((".timeSamples", ".connect")):
                    prims[parent]["attrs"][name] = val
        return i

    while i < len(tk):
        if tk[i] in ("def", "over", "class"):
            i = body(i, "/")
            if i < len(tk) and tk[i] == "}":
                i += 1
        else:
            i += 1
    return {"meta": meta, "prims": prims}


# ---------------------------------------------------------------- layer -> Scene
def _quat_matrix(q, wxyz):
    if wxyz:     # usda writes quaternions (real, i, j, k)
        w, x, y, z = q
    else:        # crate stores GfQuat as (i, j, k, real)
        x, y, z, w = q
    return mat_trs(r=(x, y, z, w))


def _op_matrix(name, v, crate):
    kind = name.split(":")[1] if ":" in name else name
    if kind == "transform":
        m = [float(x) for row in v for x in (row if isinstance(row, (tuple, list)) else [row])] if v and isinstance(v[0], (tuple, list)) else [float(x) for x in v]
        if len(m) != 16:
            return IDENTITY
        # USD matrices are row-vector (p * M): transpose to column-vector form
        return tuple(m[4 * c + r] for r in range(4) for c in range(4))
    if kind == "translate":
        return mat_trs(t=tuple(float(x) for x in v))
    if kind == "scale":
        return mat_trs(s=tuple(float(x) for x in v))
    if kind == "orient":
        return _quat_matrix([float(x) for x in v], wxyz=not crate)
    if kind.startswith("rotate"):
        axes = kind[6:]
        vals = [float(x) for x in v] if isinstance(v, (tuple, list)) else [float(v)]
        m = IDENTITY
        if len(axes) == 1:
            return mat_axis_angle({"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[axes], vals[0])
        # rotateXYZ: X applied first -> M = Rz * Ry * Rx (column vectors)
        for ax, ang in reversed(list(zip(axes, vals))):
            m = mat_mul(m, mat_axis_angle({"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[ax], ang))
        return m
    return IDENTITY


def _local(prim, crate):
    a = prim["attrs"]
    order = a.get("xformOpOrder") or []
    m = IDENTITY
    for op in order:
        if op == "!resetXformStack!":
            m = IDENTITY
            continue
        inverse = op.startswith("!invert!")
        name = op[8:] if inverse else op
        if name in a:
            om = _op_matrix(name, a[name], crate)
            if inverse:
                continue        # rare in scans: skipped
            m = mat_mul(m, om)
    return m


def layer_scene(layer, crate=False, fmt="USD"):
    prims = layer["prims"]
    meta = layer["meta"]
    up = str(meta.get("upAxis") or "Y").upper()[:1]
    unit = float(meta.get("metersPerUnit") or 0.01) if meta.get("metersPerUnit") not in (None, "") else 0.01
    worlds = {}

    def world(path):
        if path in worlds:
            return worlds[path]
        parent = path.rsplit("/", 1)[0] or "/"
        pm = IDENTITY if path == "/" or parent == path else (world(parent) if parent in prims else IDENTITY)
        m = mat_mul(pm, _local(prims[path], crate)) if path in prims else pm
        worlds[path] = m
        return m

    parts = []
    for path in sorted(prims):
        p = prims[path]
        if p["spec"] != "def":
            continue
        a = p["attrs"]
        if p["type"] == "Mesh" and a.get("points"):
            pts = a["points"]
            pos = array("d", [float(c) for q in pts for c in q[:3]])
            counts = [int(x) for x in a.get("faceVertexCounts") or []]
            idx = [int(x) for x in a.get("faceVertexIndices") or []]
            tris = array("I")
            k = 0
            for n in counts:
                for j in range(1, n - 1):
                    tris.extend((idx[k], idx[k + j], idx[k + j + 1]))
                k += n
            parts.append(Part(path, transform(pos, world(path)), tris))
        elif p["type"] == "Cube":
            s = float(a.get("size") or 2.0) / 2
            pos = array("d", [sx * s for x in range(8) for sx in ((-1 if x & 4 else 1), (-1 if x & 2 else 1), (-1 if x & 1 else 1))])
            faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
            tris = array("I", [v for f in faces for v in (f[0], f[1], f[2], f[0], f[2], f[3])])
            parts.append(Part(path, transform(pos, world(path)), tris))
    notes = []
    if meta.get("metersPerUnit") in (None, ""):
        notes.append("The USD file doesn't say its units, so centimetres (USD's default) were used.")
    return Scene(parts, up=up if up in "XYZ" else "Y", unit=unit, fmt=fmt, notes=notes)


def read_usd(data, name=""):
    """.usdz, .usdc or .usda bytes -> Scene."""
    if data[:2] == b"PK":
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise ScanError("That USDZ file is damaged (it isn't a complete zip).")
        names = [n for n in z.namelist() if n.lower().endswith((".usdc", ".usda", ".usd"))]
        if not names:
            raise ScanError("That USDZ file has no 3D model inside.")
        scene = None
        for n in names:   # the first layer is the root; try the others when it holds no geometry
            s = read_usd(z.read(n), n)
            if scene is None or (not scene.parts and s.parts):
                scene = s
            if scene.parts:
                break
        scene.fmt = "USDZ"
        return scene
    if data[:8] == b"PXR-USDC":
        try:
            return layer_scene(Crate(data).layer(), crate=True, fmt="USDC")
        except (struct.error, IndexError, KeyError) as e:
            raise ScanError(f"Riyeser couldn't read this USD file's binary data ({type(e).__name__}). "
                            "Export it again, or as GLB or OBJ.")
    text = data.decode("utf-8", "replace")
    if not text.lstrip().startswith("#usda"):
        raise ScanError("That isn't a USD file.")
    return layer_scene(parse_usda(text), crate=False, fmt="USDA")


__all__ = ["Crate", "decode_ints", "lz4_block", "parse_usda", "read_usd"]
