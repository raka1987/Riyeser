"""Sample scans Riyeser makes itself (nothing downloaded, no one else's scan): the demo's scanned room and the files
the tests import.

  room_glb()        a RoomPlan-style GLB: one box per wall, door and window, named Wall0, Door0, Window0 ... (the
                    naming RoomPlan uses), so it imports as a full room with its doors and windows.
  room_mesh()       a raw scanned-looking mesh of a room (floor, ceiling, walls cut into small triangles, a little
                    noise, a table and a cupboard in it), for the mesh room finder.
  write_glb / write_obj / write_stl / write_dae / write_usda / write_usdz   the same parts in each file format.
"""
import io
import json
import math
import random
import struct
import zipfile


def box(cx, cy, cz, sx, sy, sz, yaw=0.0):
    """A box's 12 triangles (centre, size, turned `yaw` degrees about the up axis)."""
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    pts = []
    for dx in (-1, 1):
        for dy in (-1, 1):
            for dz in (-1, 1):
                x, y, z = dx * sx / 2, dy * sy / 2, dz * sz / 2
                pts.append((cx + c * x + s * z, cy + y, cz - s * x + c * z))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return [(pts[f[0]], pts[f[1]], pts[f[2]]) for f in faces] + [(pts[f[0]], pts[f[2]], pts[f[3]]) for f in faces]


def room_parts(L=4.2, W=3.6, H=2.4, origin=(0.0, 0.0), yaw=0.0):
    """[(name, triangles)] for a RoomPlan-style room L x W x H (metres), floor at y=0, a door and a window."""
    ox, oz = origin
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))

    def at(x, z):
        return ox + c * x + s * z, oz - s * x + c * z
    walls = [((0, -W / 2), L, 0), ((L / 2, 0), W, 90), ((0, W / 2), L, 180), ((-L / 2, 0), W, 270)]
    parts = []
    for i, ((x, z), ln, a) in enumerate(walls):
        X, Z = at(x, z)
        parts.append((f"Wall{i}", box(X, H / 2, Z, ln, H, 0.01, a + yaw)))
    X, Z = at(L / 2 - 0.9, -W / 2)
    parts.append(("Door0", box(X, 1.02, Z, 0.82, 2.04, 0.04, yaw)))
    X, Z = at(-L / 2, 0.2)
    parts.append(("Window0", box(X, 0.9 + 0.6, Z, 1.8, 1.2, 0.04, 270 + yaw)))
    return parts


def room_mesh(L=4.0, W=3.0, H=2.5, cell=0.25, noise=0.008, seed=3, furniture=True, ceiling=True, yaw=0.0):
    """A raw mesh like a phone's LiDAR scan: surfaces cut into ~cell-sized triangles with noise."""
    rng = random.Random(seed)
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))

    def P(x, y, z):
        j = lambda: rng.uniform(-noise, noise)  # noqa: E731
        return (c * x + s * z + j(), y + j(), -s * x + c * z + j())

    tris = []

    def quad(o, u, v, nu, nv):
        for i in range(nu):
            for k in range(nv):
                def q(a, b):
                    return P(o[0] + u[0] * a / nu + v[0] * b / nv, o[1] + u[1] * a / nu + v[1] * b / nv,
                             o[2] + u[2] * a / nu + v[2] * b / nv)
                p00, p10, p01, p11 = q(i, k), q(i + 1, k), q(i, k + 1), q(i + 1, k + 1)
                tris.append((p00, p10, p11))
                tris.append((p00, p11, p01))
    n = lambda d: max(1, round(d / cell))  # noqa: E731
    x0, z0 = -L / 2, -W / 2
    quad((x0, 0, z0), (L, 0, 0), (0, 0, W), n(L), n(W))                    # floor
    if ceiling:
        quad((x0, H, z0), (L, 0, 0), (0, 0, W), n(L), n(W))
    quad((x0, 0, z0), (L, 0, 0), (0, H, 0), n(L), n(H))
    quad((x0, 0, -z0), (L, 0, 0), (0, H, 0), n(L), n(H))
    quad((x0, 0, z0), (0, 0, W), (0, H, 0), n(W), n(H))
    quad((-x0, 0, z0), (0, 0, W), (0, H, 0), n(W), n(H))
    if furniture:
        for b in (box(0.3, 0.375, 0.2, 1.4, 0.75, 0.8), box(-L / 2 + 0.35, 1.0, -0.5, 0.6, 2.0, 1.2)):
            # a phone can't see the back of a cupboard against a wall, or under a table: leave those faces out
            tris += [tuple(P(*p) for p in t) for t in b
                     if not all(abs(p[0]) > L / 2 - 0.1 or p[1] < 0.01 for p in t)]
    return [("Mesh", tris)]


# ---------------------------------------------------------------- writers
def _flat(parts):
    out = []
    for name, tris in parts:
        out.append((name, [v for t in tris for p in t for v in p]))
    return out


def write_glb(parts):
    nodes, meshes, accessors, views, blob = [], [], [], [], bytearray()
    for i, (name, flat) in enumerate(_flat(parts)):
        b = struct.pack(f"<{len(flat)}f", *flat)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(b)})
        blob += b
        xs, ys, zs = flat[0::3], flat[1::3], flat[2::3]
        accessors.append({"bufferView": i, "componentType": 5126, "count": len(flat) // 3, "type": "VEC3",
                          "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": i}, "mode": 4}]})
        nodes.append({"name": name, "mesh": i})
    js = {"asset": {"version": "2.0", "generator": "Riyeser sample"}, "scene": 0,
          "scenes": [{"nodes": [len(nodes)]}],
          "nodes": nodes + [{"name": "Room", "children": list(range(len(nodes)))}],
          "meshes": meshes, "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    j = json.dumps(js).encode()
    j += b" " * (-len(j) % 4)
    blob += b"\0" * (-len(blob) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(blob)) + struct.pack("<II", len(j), 0x4E4F534A)
            + j + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def write_obj(parts, scale=1.0, z_up=False):
    lines, n = ["# Riyeser sample scan"], 0
    for name, tris in parts:
        lines.append(f"o {name}")
        for t in tris:
            for x, y, z in t:
                if z_up:
                    y, z = -z, y
                lines.append(f"v {x * scale:.5f} {y * scale:.5f} {z * scale:.5f}")
        for k in range(len(tris)):
            lines.append(f"f {n + 3 * k + 1} {n + 3 * k + 2} {n + 3 * k + 3}")
        n += 3 * len(tris)
    return ("\n".join(lines) + "\n").encode()


def write_stl(parts):
    tris = [t for _n, ts in parts for t in ts]
    out = bytearray(b"Riyeser sample".ljust(80, b" ") + struct.pack("<I", len(tris)))
    for t in tris:
        out += struct.pack("<12fH", 0, 0, 0, *[v for p in t for v in p], 0)
    return bytes(out)


def write_dae(parts, z_up=False):
    geo, nodes = [], []
    for i, (name, flat) in enumerate(_flat(parts)):
        if z_up:
            flat = [v for k in range(0, len(flat), 3) for v in (flat[k], -flat[k + 2], flat[k + 1])]
        n = len(flat) // 3
        geo.append(f'<geometry id="g{i}" name="{name}"><mesh><source id="g{i}-p"><float_array id="g{i}-a" count="{len(flat)}">'
                   + " ".join(f"{v:.5f}" for v in flat)
                   + f'</float_array><technique_common><accessor source="#g{i}-a" count="{n}" stride="3"/></technique_common>'
                   f'</source><vertices id="g{i}-v"><input semantic="POSITION" source="#g{i}-p"/></vertices>'
                   f'<triangles count="{n // 3}"><input semantic="VERTEX" source="#g{i}-v" offset="0"/><p>'
                   + " ".join(str(k) for k in range(n)) + "</p></triangles></mesh></geometry>")
        nodes.append(f'<node id="n{i}" name="{name}"><matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix>'
                     f'<instance_geometry url="#g{i}"/></node>')
    return ('<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
            f'<asset><unit meter="1"/><up_axis>{"Z_UP" if z_up else "Y_UP"}</up_axis></asset>'
            f'<library_geometries>{"".join(geo)}</library_geometries><library_visual_scenes><visual_scene id="s">'
            f'{"".join(nodes)}</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#s"/></scene>'
            '</COLLADA>').encode()


def write_usda(parts, meters_per_unit=1.0):
    out = ["#usda 1.0", f'(\n    metersPerUnit = {meters_per_unit}\n    upAxis = "Y"\n)', 'def Xform "Room"', "{"]
    k = 1.0 / meters_per_unit
    for name, tris in parts:
        pts = ", ".join(f"({x * k:.5f}, {y * k:.5f}, {z * k:.5f})" for t in tris for x, y, z in t)
        out += [f'    def Xform "{name}"', "    {", "        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )",
                '        uniform token[] xformOpOrder = ["xformOp:transform"]', f'        def Mesh "{name}"', "        {",
                f"            int[] faceVertexCounts = [{', '.join(['3'] * len(tris))}]",
                f"            int[] faceVertexIndices = [{', '.join(str(i) for i in range(3 * len(tris)))}]",
                f"            point3f[] points = [{pts}]", "        }", "    }"]
    out.append("}")
    return ("\n".join(out) + "\n").encode()


def write_usdz(layer_bytes, name="scene.usda"):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_STORED) as z:     # USDZ: an uncompressed zip, the layer first
        z.writestr(name, layer_bytes)
    return b.getvalue()


def capturedroom_json(L=4.2, W=3.6, H=2.4):
    """The JSON a RoomPlan app saves for a CapturedRoom (Swift Codable): sizes, and transforms column by column."""
    def surf(cat, w, h, x, y, z, yaw):
        c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        # columns: x axis, y axis, z axis, position (a turn about Y)
        return {"category": {cat: {}}, "confidence": {"high": {}}, "dimensions": [w, h, 0],
                "completedEdges": [], "parentIdentifier": None, "identifier": f"{cat}-{x}-{z}", "curve": None,
                "transform": [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]}
    walls = [surf("wall", L, H, 0, H / 2 - 1.2, -W / 2, 0), surf("wall", W, H, L / 2, H / 2 - 1.2, 0, 90),
             surf("wall", L, H, 0, H / 2 - 1.2, W / 2, 180), surf("wall", W, H, -L / 2, H / 2 - 1.2, 0, 270)]
    door = surf("door", 0.82, 2.04, L / 2 - 0.9, 1.02 - 1.2, -W / 2, 0)
    door["category"] = {"door": {"isOpen": False}}
    return {"identifier": "sample", "version": 2, "walls": walls, "doors": [door],
            "windows": [surf("window", 1.8, 1.2, -L / 2, 1.5 - 1.2, 0.2, 270)], "openings": [], "objects": [],
            "floors": [], "sections": [{"label": {"livingRoom": {}}, "center": [0, 0, 0], "story": 0}]}


def write_dxf(units_mm=True, lines_only=False):
    """An ASCII DXF floor plan like a scanning app's: two rooms (a 4.2 x 3.6 m bedroom and a 2.4 x 3.6 m bathroom),
    walls drawn with both faces, a door (leaf + swing) on DOORS, a window on WINDOWS, room names as TEXT."""
    k = 1000.0 if units_mm else 1.0
    out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4" if units_mm else "6", "0", "ENDSEC",
           "0", "SECTION", "2", "ENTITIES"]

    def poly(pts, layer, closed=True):
        if lines_only:
            for i in range(len(pts) - (0 if closed else 1)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                out.extend(["0", "LINE", "8", layer, "10", f"{a[0] * k:g}", "20", f"{a[1] * k:g}", "11",
                            f"{b[0] * k:g}", "21", f"{b[1] * k:g}"])
            return
        out.extend(["0", "LWPOLYLINE", "8", layer, "90", str(len(pts)), "70", "1" if closed else "0"])
        for x, y in pts:
            out.extend(["10", f"{x * k:g}", "20", f"{y * k:g}"])
    t = 0.1
    poly([(0, 0), (4.2, 0), (4.2, 3.6), (0, 3.6)], "WALLS")                       # bedroom (inside faces)
    poly([(4.2 + t, 0), (6.6 + t, 0), (6.6 + t, 3.6), (4.2 + t, 3.6)], "WALLS")   # bathroom
    poly([(-t, -t), (6.6 + 2 * t, -t), (6.6 + 2 * t, 3.6 + t), (-t, 3.6 + t)], "WALLS")  # outside face
    # the door in the bedroom's bottom wall: hinge at x=0.5, 0.82 wide, swinging in
    out.extend(["0", "LINE", "8", "DOORS", "10", f"{0.5 * k:g}", "20", "0", "11", f"{0.5 * k:g}", "21", f"{0.82 * k:g}"])
    out.extend(["0", "ARC", "8", "DOORS", "10", f"{0.5 * k:g}", "20", "0", "40", f"{0.82 * k:g}", "50", "0", "51", "90"])
    # a 1.8 m window in the bedroom's top wall
    poly([(1.2, 3.6), (3.0, 3.6), (3.0, 3.6 + t), (1.2, 3.6 + t)], "WINDOWS")
    for (x, y), txt in (((2.1, 1.8), "Bedroom"), ((5.5, 1.8), "Bathroom"), ((2.1, 1.4), "15.12 m²")):
        out.extend(["0", "TEXT", "8", "LABELS", "10", f"{x * k:g}", "20", f"{y * k:g}", "40", "100", "1", txt])
    out.extend(["0", "ENDSEC", "0", "EOF"])
    return ("\n".join(out) + "\n").encode()


def write_csv():
    """A room list like Magicplan's statistics export."""
    return ("Project;Sample house\nFloor;Room;Area (m²);Perimeter (m);Height (m);Wall area (m²)\n"
            "Ground floor;Living room;20,00;18,00;2,40;43,20\nGround floor;Kitchen;9,00;12,00;2,40;28,80\n"
            "Ground floor;Total;29,00;;;\n").encode("utf-8")
