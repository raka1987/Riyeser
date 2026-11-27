"""3D mesh files -> a Scene: named parts, each a list of vertices (world coordinates) and triangles.

  GLB / glTF 2.0   binary glTF (one file), or .gltf JSON with its buffers embedded as data: URIs. Y up, metres
                   (the glTF spec). Draco or meshopt compressed files can't be read: export without compression.
  OBJ              Wavefront OBJ (v / f lines; o / g name the parts). No units in the file: metres assumed, or
                   centimetres / millimetres when the model is far too big for metres.
  DAE              COLLADA 1.4/1.5 (<up_axis>, <unit meter=...>, node transforms, triangles/polylist/polygons).
  STL              binary or ASCII. Units as OBJ.

Everything is pure Python (struct, array, zipfile, xml.etree): no 3D libraries. Big files are fine: vertex data is
read with array.frombytes, and the room finder (planes.py) works on an even sample of at most ~150,000 triangles.
"""
import base64
import json
import math
import re
import struct
import xml.etree.ElementTree as ET
from array import array


class ScanError(ValueError):
    """A file we can't read, with a plain message for the person importing it."""


class Part:
    __slots__ = ("name", "pos", "tris")

    def __init__(self, name, pos, tris):
        self.name = name or ""
        self.pos = pos          # array('d' or 'f'): x, y, z, x, y, z ...
        self.tris = tris        # array('I' / 'L'): a, b, c, a, b, c ... (vertex indices)

    @property
    def n_tris(self):
        return len(self.tris) // 3

    def vertex(self, i):
        p = self.pos
        return p[3 * i], p[3 * i + 1], p[3 * i + 2]


class Scene:
    """Parts in Y-up metres once normalise() has run. `up` is the file's up axis, `unit` its metres per unit."""

    def __init__(self, parts=None, up="Y", unit=1.0, fmt="", notes=None, unit_known=True):
        self.parts = [p for p in (parts or []) if p.n_tris]
        self.up = up
        self.unit = unit
        self.fmt = fmt
        self.notes = list(notes or [])
        self.unit_known = unit_known

    @property
    def n_tris(self):
        return sum(p.n_tris for p in self.parts)

    def bounds(self):
        lo, hi = [math.inf] * 3, [-math.inf] * 3
        for p in self.parts:
            for k in range(3):
                vals = p.pos[k::3]
                if vals:
                    lo[k] = min(lo[k], min(vals))
                    hi[k] = max(hi[k], max(vals))
        return lo, hi

    def normalise(self, guess_up=False):
        """Turn the parts into Y-up metres (in place). With guess_up (OBJ, STL: no axis in the file), a model whose
        Z axis plainly carries the floor and ceiling is turned Z-up -> Y-up."""
        if guess_up and self.parts:
            ax = _guess_up(self)
            if ax != self.up:
                self.notes.append(f"The file has no 'up' direction; it looks {ax}-up, so it was turned upright.")
                self.up = ax
        if not self.unit_known and self.parts:
            lo, hi = self.bounds()
            ext = max(h - l for l, h in zip(lo, hi))
            if ext >= 1200:      # a room or house in metres is 2 to 60 across: 1,200+ is millimetres
                self.unit = 0.001
                self.notes.append("The file has no units and the model is large, so it was read as millimetres. Check the sizes.")
            elif ext > 60:
                self.unit = 0.01
                self.notes.append("The file has no units and the model is large, so it was read as centimetres. Check the sizes.")
        s = float(self.unit or 1.0)
        for p in self.parts:
            pos = p.pos
            out = array("d", bytes(8 * len(pos)))
            if self.up == "Z":      # (x, y, z) Z-up -> (x, z, -y) Y-up
                for i in range(0, len(pos), 3):
                    out[i], out[i + 1], out[i + 2] = pos[i] * s, pos[i + 2] * s, -pos[i + 1] * s
            elif self.up == "X":
                for i in range(0, len(pos), 3):
                    out[i], out[i + 1], out[i + 2] = -pos[i + 1] * s, pos[i] * s, pos[i + 2] * s
            elif s != 1.0:
                for i in range(len(pos)):
                    out[i] = pos[i] * s
            else:
                out = array("d", pos)
            p.pos = out
        self.up, self.unit = "Y", 1.0
        return self

    def sample_triangles(self, limit=150000):
        """[(a, b, c)] vertex triples, an even sample of at most `limit` triangles across all parts."""
        total = self.n_tris
        step = max(1, math.ceil(total / limit)) if limit else 1
        out = []
        k = 0
        for p in self.parts:
            t, pos = p.tris, p.pos
            for j in range(0, len(t), 3):
                if k % step == 0:
                    a, b, c = 3 * t[j], 3 * t[j + 1], 3 * t[j + 2]
                    out.append(((pos[a], pos[a + 1], pos[a + 2]), (pos[b], pos[b + 1], pos[b + 2]),
                                (pos[c], pos[c + 1], pos[c + 2])))
                k += 1
        return out, step

    def preview(self, limit=60000):
        """float32 bytes of triangle corners (x, y, z per corner) for the 3D viewer's "show the scan" layer."""
        tris, _ = self.sample_triangles(limit)
        a = array("f", [v for tri in tris for p in tri for v in p])
        return a.tobytes()


def _guess_up(scene):
    """The axis a room stands on: the one whose biggest flat surface at either end of the model (the floor, or the
    ceiling) is largest. Walls are flat too, but a room's floor is usually bigger than its longest wall. Y (the
    usual) wins unless another axis is clearly ahead."""
    tris, _ = scene.sample_triangles(20000)
    lo, hi = scene.bounds()
    ext = [max(h - l, 1e-9) for l, h in zip(lo, hi)]
    ends = [[0.0, 0.0] for _ in range(3)]
    for a, b, c in tris:
        n = _cross(_sub(b, a), _sub(c, a))
        L = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        if L <= 0:
            continue
        for k in range(3):
            if abs(n[k]) / L > 0.966:
                m = (a[k] + b[k] + c[k]) / 3
                if m - lo[k] < 0.04 * ext[k]:
                    ends[k][0] += L / 2
                elif hi[k] - m < 0.04 * ext[k]:
                    ends[k][1] += L / 2
    score = [max(e) for e in ends]
    best = max(range(3), key=lambda k: score[k])
    if best != 1 and score[best] > 1.1 * score[1]:
        return "XYZ"[best]
    return "Y"


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(u, v):
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


# ---------------------------------------------------------------- 4x4 matrices (row-major lists, column vectors)
IDENTITY = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)


def mat_mul(a, b):
    return tuple(sum(a[4 * r + k] * b[4 * k + c] for k in range(4)) for r in range(4) for c in range(4))


def mat_trs(t=None, r=None, s=None):
    """Translation, rotation quaternion (x, y, z, w), scale -> matrix (T * R * S)."""
    x, y, z, w = r or (0.0, 0.0, 0.0, 1.0)
    sx, sy, sz = s or (1.0, 1.0, 1.0)
    tx, ty, tz = t or (0.0, 0.0, 0.0)
    R = (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
         2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
         2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y))
    return (R[0] * sx, R[1] * sy, R[2] * sz, tx, R[3] * sx, R[4] * sy, R[5] * sz, ty,
            R[6] * sx, R[7] * sy, R[8] * sz, tz, 0.0, 0.0, 0.0, 1.0)


def mat_axis_angle(axis, deg):
    x, y, z = axis
    L = math.sqrt(x * x + y * y + z * z) or 1.0
    x, y, z = x / L, y / L, z / L
    h = math.radians(deg) / 2
    s = math.sin(h)
    return mat_trs(r=(x * s, y * s, z * s, math.cos(h)))


def transform(pos, m):
    """Apply a matrix to a flat xyz array (returns a new array('d'))."""
    if m == IDENTITY:
        return array("d", pos)
    out = array("d", bytes(8 * len(pos)))
    a, b, c, d, e, f, g, h, i, j, k, l = m[:12]
    for n in range(0, len(pos), 3):
        x, y, z = pos[n], pos[n + 1], pos[n + 2]
        out[n] = a * x + b * y + c * z + d
        out[n + 1] = e * x + f * y + g * z + h
        out[n + 2] = i * x + j * y + k * z + l
    return out


# ---------------------------------------------------------------- glTF / GLB
_COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_gltf(data, name=""):
    """GLB (binary) or glTF JSON with embedded buffers -> Scene (Y up, metres)."""
    if data[:4] == b"glTF":
        if len(data) < 20:
            raise ScanError("That GLB file is cut short.")
        _magic, _ver, length = struct.unpack_from("<III", data, 0)
        off, js, binchunk = 12, None, None
        while off + 8 <= min(length, len(data)):
            clen, ctype = struct.unpack_from("<II", data, off)
            chunk = data[off + 8: off + 8 + clen]
            if ctype == 0x4E4F534A:
                js = json.loads(chunk.decode("utf-8"))
            elif ctype == 0x004E4942 and binchunk is None:
                binchunk = chunk
            off += 8 + clen
        if js is None:
            raise ScanError("That GLB file has no scene in it.")
    else:
        try:
            js = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise ScanError("That .gltf file isn't valid. Export it as GLB (binary glTF) and try again.")
        binchunk = None
    ext = set(js.get("extensionsRequired") or []) | set(js.get("extensionsUsed") or [])
    if {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"} & ext:
        raise ScanError("This model is compressed (Draco or meshopt), which Riyeser can't read. Export it again "
                        "without mesh compression (in Polycam: GLB, with compression off), or as OBJ.")
    buffers = []
    for b in js.get("buffers") or []:
        uri = b.get("uri")
        if uri is None:
            buffers.append(binchunk or b"")
        elif uri.startswith("data:"):
            buffers.append(base64.b64decode(uri.split(",", 1)[1]))
        else:
            raise ScanError("This .gltf file keeps its geometry in a separate .bin file. Export it as GLB (one file) "
                            "and import that instead.")
    views = js.get("bufferViews") or []
    accessors = js.get("accessors") or []

    def acc(i):
        a = accessors[i]
        code, size = _COMP[a["componentType"]]
        nc = _NCOMP[a["type"]]
        count = a["count"]
        if "bufferView" not in a:
            return array(code if code != "f" else "f", bytes(size * nc * count))
        v = views[a["bufferView"]]
        buf = buffers[v.get("buffer", 0)]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride") or size * nc
        out = array(code)
        if stride == size * nc:
            out.frombytes(buf[start: start + size * nc * count])
        else:
            for n in range(count):
                out.frombytes(buf[start + n * stride: start + n * stride + size * nc])
        if struct.pack("=H", 1) != b"\x01\x00":
            out.byteswap()
        if a.get("normalized") and code != "f":
            mx = float(2 ** (8 * size - (1 if code.islower() else 0)) - 1)
            out = array("f", [max(-1.0, x / mx) for x in out])
        return out

    meshes = js.get("meshes") or []
    nodes = js.get("nodes") or []
    parts = []

    def local(nd):
        if "matrix" in nd:
            m = nd["matrix"]           # column-major in glTF
            return tuple(float(m[4 * c + r]) for r in range(4) for c in range(4))
        return mat_trs(nd.get("translation"), nd.get("rotation"), nd.get("scale"))

    def walk(i, parent, path, seen):
        if i in seen or i >= len(nodes):
            return
        seen = seen | {i}
        nd = nodes[i]
        m = mat_mul(parent, local(nd))
        here = path + "/" + (nd.get("name") or f"node{i}")
        if "mesh" in nd:
            mesh = meshes[nd["mesh"]]
            for k, prim in enumerate(mesh.get("primitives") or []):
                mode = prim.get("mode", 4)
                pa = (prim.get("attributes") or {}).get("POSITION")
                if pa is None or mode not in (4, 5, 6):
                    continue
                pos = acc(pa)
                n = len(pos) // 3
                idx = array("I", acc(prim["indices"])) if prim.get("indices") is not None else array("I", range(n))
                if mode == 5:
                    idx = array("I", [v for j in range(len(idx) - 2) for v in
                                      ((idx[j], idx[j + 1], idx[j + 2]) if j % 2 == 0 else (idx[j + 1], idx[j], idx[j + 2]))])
                elif mode == 6:
                    idx = array("I", [v for j in range(1, len(idx) - 1) for v in (idx[0], idx[j], idx[j + 1])])
                nm = here if len(mesh.get("primitives")) == 1 else f"{here}/{k}"
                parts.append(Part(nm + ("/" + mesh["name"] if mesh.get("name") else ""), transform(pos, m),
                                  idx[: len(idx) // 3 * 3]))
        for ch in nd.get("children") or []:
            walk(ch, m, here, seen)

    scenes = js.get("scenes") or []
    if scenes:
        roots = scenes[js.get("scene", 0) or 0].get("nodes") or []
    else:
        kids = {c for nd in nodes for c in nd.get("children") or []}
        roots = [i for i in range(len(nodes)) if i not in kids]
    for r in roots:
        walk(r, IDENTITY, "", frozenset())
    return Scene(parts, up="Y", unit=1.0, fmt="glTF")


# ---------------------------------------------------------------- OBJ
def read_obj(data, name=""):
    """Wavefront OBJ -> Scene (units and up axis guessed later: OBJ has neither)."""
    verts = array("d")
    parts, cur_name, cur = [], "", array("I")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    nv = 0
    for line in text.splitlines():
        if not line or line[0] == "#":
            continue
        c0 = line[:2]
        if c0 == "v ":
            bits = line.split()
            verts.extend((float(bits[1]), float(bits[2]), float(bits[3])))
            nv += 1
        elif c0 == "f ":
            ids = []
            for tok in line.split()[1:]:
                v = int(tok.split("/", 1)[0])
                ids.append(v - 1 if v > 0 else nv + v)
            for j in range(1, len(ids) - 1):
                cur.extend((ids[0], ids[j], ids[j + 1]))
        elif c0 in ("o ", "g "):
            if cur:
                parts.append((cur_name, cur))
                cur = array("I")
            cur_name = line[2:].strip()
    if cur:
        parts.append((cur_name, cur))
    if not nv:
        raise ScanError("That OBJ file has no points in it.")
    out = []
    for nm, tris in parts:     # all parts share the vertex list: give each part only the vertices it uses
        used = sorted(set(tris))
        remap = {v: k for k, v in enumerate(used)}
        pos = array("d")
        for v in used:
            pos.extend(verts[3 * v: 3 * v + 3])
        out.append(Part(nm, pos, array("I", [remap[v] for v in tris])))
    return Scene(out, up="Y", unit=1.0, fmt="OBJ", unit_known=False)


# ---------------------------------------------------------------- STL
def read_stl(data, name=""):
    pos = array("d")
    if data[:5].lower() == b"solid" and b"facet" in data[:1000]:
        for m in re.finditer(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data):
            pos.extend(float(x) for x in m.groups())
    else:
        if len(data) < 84:
            raise ScanError("That STL file is cut short.")
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * n > len(data):
            raise ScanError("That STL file is cut short.")
        for k in range(n):
            pos.extend(struct.unpack_from("<9f", data, 84 + 50 * k + 12))
    return Scene([Part(name or "STL", pos, array("I", range(len(pos) // 3)))], up="Y", unit=1.0, fmt="STL",
                 unit_known=False)


# ---------------------------------------------------------------- COLLADA (.dae)
def read_dae(data, name=""):
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise ScanError("That .dae (COLLADA) file isn't valid XML.")
    ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""

    def q(path):
        return "/".join(ns + t for t in path.split("/"))
    asset = root.find(q("asset"))
    up, unit = "Y", 1.0
    if asset is not None:
        u = asset.find(q("unit"))
        if u is not None and u.get("meter"):
            unit = float(u.get("meter"))
        ua = asset.find(q("up_axis"))
        if ua is not None and ua.text:
            up = ua.text.strip()[0].upper()
    geoms = {}
    for geo in root.iter(ns + "geometry"):
        mesh = geo.find(q("mesh"))
        if mesh is None:
            continue
        sources = {}
        for src in mesh.findall(q("source")):
            fa = src.find(q("float_array"))
            if fa is not None and fa.text:
                acc_ = src.find(q("technique_common/accessor"))
                stride = int(acc_.get("stride", 3)) if acc_ is not None else 3
                sources[src.get("id")] = (array("d", map(float, fa.text.split())), stride)
        verts = {}
        for v in mesh.findall(q("vertices")):
            for inp in v.findall(q("input")):
                if inp.get("semantic") == "POSITION":
                    verts[v.get("id")] = inp.get("source", "").lstrip("#")
        pos_src, tris = None, array("I")
        for tag in ("triangles", "polylist", "polygons"):
            for prim in mesh.findall(q(tag)):
                inputs = prim.findall(q("input"))
                stride = max(int(i.get("offset", 0)) for i in inputs) + 1 if inputs else 1
                voff = None
                for i in inputs:
                    if i.get("semantic") == "VERTEX":
                        voff = int(i.get("offset", 0))
                        pos_src = verts.get(i.get("source", "").lstrip("#"))
                if voff is None:
                    continue
                ps = prim.findall(q("p"))
                if tag == "triangles":
                    idx = [int(x) for p in ps for x in (p.text or "").split()]
                    vs = idx[voff::stride]
                    tris.extend(vs[: len(vs) // 3 * 3])
                elif tag == "polylist":
                    vc = [int(x) for x in (prim.find(q("vcount")).text or "").split()] if prim.find(q("vcount")) is not None else []
                    idx = [int(x) for p in ps for x in (p.text or "").split()]
                    vs = idx[voff::stride]
                    k = 0
                    for n in vc:
                        poly = vs[k: k + n]
                        k += n
                        for j in range(1, n - 1):
                            tris.extend((poly[0], poly[j], poly[j + 1]))
                else:
                    for p in ps:
                        poly = [int(x) for x in (p.text or "").split()][voff::stride]
                        for j in range(1, len(poly) - 1):
                            tris.extend((poly[0], poly[j], poly[j + 1]))
        if pos_src and pos_src in sources and tris:
            arr, stride = sources[pos_src]
            if stride != 3:
                arr = array("d", [arr[i + k] for i in range(0, len(arr), stride) for k in range(3)])
            geoms[geo.get("id")] = (geo.get("name") or geo.get("id") or "", arr, tris)
    library_nodes = {n.get("id"): n for ln in root.iter(ns + "library_nodes") for n in ln.findall(q("node"))}
    parts = []

    def node_matrix(nd):
        m = IDENTITY
        for ch in nd:
            tag = ch.tag[len(ns):]
            vals = [float(x) for x in (ch.text or "").split()]
            if tag == "matrix" and len(vals) == 16:
                m = mat_mul(m, tuple(vals))          # COLLADA matrices are row-major, column vectors
            elif tag == "translate" and len(vals) == 3:
                m = mat_mul(m, mat_trs(t=vals))
            elif tag == "rotate" and len(vals) == 4:
                m = mat_mul(m, mat_axis_angle(vals[:3], vals[3]))
            elif tag == "scale" and len(vals) == 3:
                m = mat_mul(m, mat_trs(s=vals))
        return m

    def walk(nd, parent, path, depth=0):
        if depth > 64:
            return
        m = mat_mul(parent, node_matrix(nd))
        here = path + "/" + (nd.get("name") or nd.get("id") or "node")
        for ig in nd.findall(q("instance_geometry")):
            g = geoms.get(ig.get("url", "").lstrip("#"))
            if g:
                parts.append(Part(here + "/" + g[0], transform(g[1], m), array("I", g[2])))
        for inn in nd.findall(q("instance_node")):
            ref = library_nodes.get(inn.get("url", "").lstrip("#"))
            if ref is not None:
                walk(ref, m, here, depth + 1)
        for ch in nd.findall(q("node")):
            walk(ch, m, here, depth + 1)

    scenes = list(root.iter(ns + "visual_scene"))
    if scenes:
        for nd in scenes[0].findall(q("node")):
            walk(nd, IDENTITY, "")
    else:
        for gid, g in geoms.items():
            parts.append(Part(g[0], g[1], array("I", g[2])))
    return Scene(parts, up=up if up in "XYZ" else "Y", unit=unit, fmt="COLLADA")
