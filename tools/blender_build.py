# Baut alle Spielmodelle prozedural in Blender und exportiert sie als eine GLB-Datei.
# Aufruf in Blender:  exec(open(".../tools/blender_build.py").read())
import bpy, bmesh, math, random
from mathutils import Vector, Matrix, noise

OUT_GLB = globals().get("OUT_GLB", "")


def srgb(h):
    h = h.lstrip('#')
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b), 1.0)


def shade(c, k):
    return (min(1, c[0] * k), min(1, c[1] * k), min(1, c[2] * k), 1.0)


def mixc(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3)) + (1.0,)


class MB:
    """Kleiner Mesh-Builder mit Vertexfarben."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")

    def add(self, verts, faces, color, smooth=False, M=None, facecols=None):
        bv = []
        for v in verts:
            p = Vector(v)
            if M is not None:
                p = M @ p
            bv.append(self.bm.verts.new(p))
        for fi, f in enumerate(faces):
            if len(set(f)) < 3:
                continue
            try:
                face = self.bm.faces.new([bv[i] for i in f])
            except ValueError:
                continue
            face.smooth = smooth
            for k, loop in enumerate(face.loops):
                if facecols is not None:
                    loop[self.col] = facecols[fi]
                elif isinstance(color, list):
                    loop[self.col] = color[f[k]]
                else:
                    loop[self.col] = color

    def build(self, name, recalc=True):
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.color_attributes.render_color_index = 0
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        ob.data.materials.append(get_mat())
        return ob


def get_mat():
    m = bpy.data.materials.get("VCol")
    if m:
        return m
    m = bpy.data.materials.new("VCol")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    att = nt.nodes.new("ShaderNodeVertexColor")
    att.layer_name = "Col"
    nt.links.new(att.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.8
    return m


def lathe(rings, seg=12, cols=None, cap_bot=True, cap_top=True, rot=0.0):
    verts, vcols = [], []
    for ri, r in enumerate(rings):
        z, rx = r[0], r[1]
        ry = r[2] if len(r) > 2 and r[2] is not None else rx
        ox = r[3] if len(r) > 3 else 0
        oy = r[4] if len(r) > 4 else 0
        for j in range(seg):
            a = rot + j / seg * 2 * math.pi
            verts.append((ox + rx * math.cos(a), oy + ry * math.sin(a), z))
            if cols:
                vcols.append(cols[ri])
    faces = []
    n = len(rings)
    for i in range(n - 1):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    if cap_bot:
        faces.append(tuple(reversed(range(seg))))
    if cap_top:
        faces.append(tuple((n - 1) * seg + j for j in range(seg)))
    return verts, faces, vcols


def sphere_rings(cz, rx, ry, rz, n=8, ox=0, oy=0):
    out = []
    for i in range(n + 1):
        a = math.pi * i / n
        s = max(0.02, math.sin(a))
        out.append((cz - rz * math.cos(a), rx * s, ry * s, ox, oy))
    return out


def box(sx, sy, sz, c=(0, 0, 0)):
    x, y, z = sx / 2, sy / 2, sz / 2
    cx, cy, cz = c
    v = [(cx - x, cy - y, cz - z), (cx + x, cy - y, cz - z), (cx + x, cy + y, cz - z), (cx - x, cy + y, cz - z),
         (cx - x, cy - y, cz + z), (cx + x, cy - y, cz + z), (cx + x, cy + y, cz + z), (cx - x, cy + y, cz + z)]
    f = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def extrude_xz(pts, y0, y1):
    n = len(pts)
    v = [(p[0], y0, p[1]) for p in pts] + [(p[0], y1, p[1]) for p in pts]
    f = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    f.append(tuple(range(n)))
    f.append(tuple(n + i for i in reversed(range(n))))
    return v, f


def bevel(ob, width, segs=2):
    m = ob.modifiers.new("Bevel", 'BEVEL')
    m.width = width
    m.segments = segs
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(40)


# ---------------------------------------------------------------- Bäume
def make_tree(name, seed, H, R, tiers):
    rnd = random.Random(seed)
    mb = MB()
    trunkH = H * 0.13
    tr = 0.03 * H + 0.05
    bark = srgb('#4b3626')
    v, f, _ = lathe([(-0.4, tr * 1.5), (trunkH, tr * 1.1), (H * 0.55, tr * 0.5)], seg=6)
    mb.add(v, f, bark)
    seg = 10
    g_dark, g_mid, g_lite = srgb('#173d2c'), srgb('#215239'), srgb('#2f6b47')
    snow_hi, snow_lo = srgb('#ffffff'), srgb('#d3e2f5')
    for i in range(tiers):
        t = i / (tiers - 1)
        zb = trunkH + (H - trunkH) * 0.86 * t
        th = (H - trunkH) / tiers * 2.1
        za = min(H, zb + th) if i < tiers - 1 else H
        r = R * (1 - 0.8 * t) * (0.92 + 0.16 * rnd.random())
        rot = rnd.random() * 6.28
        k = 0.85 + 0.3 * rnd.random()
        cx, cy = (rnd.random() - 0.5) * 0.08 * R, (rnd.random() - 0.5) * 0.08 * R
        rim, mid, srim, smid = [], [], [], []
        for j in range(seg):
            a = rot + j / seg * 6.2832
            long = (j % 2 == 0)
            rf = (1.0 if long else 0.66) * (0.88 + 0.24 * rnd.random())
            droop = (0.22 if long else 0.04) * r * (0.7 + 0.6 * rnd.random())
            pr = Vector((cx + math.cos(a) * r * rf, cy + math.sin(a) * r * rf, zb - droop))
            pm = Vector((cx + math.cos(a) * r * 0.42, cy + math.sin(a) * r * 0.42, zb + (za - zb) * 0.42))
            rim.append(pr)
            mid.append(pm)
            s = (0.16 if long else 0.5) + 0.12 * rnd.random()
            ps = pr.lerp(pm, s)
            ps.z += 0.05 + 0.012 * H
            ps.x = cx + (ps.x - cx) * 1.05
            ps.y = cy + (ps.y - cy) * 1.05
            srim.append(ps)
            pm2 = pm.copy()
            pm2.z += 0.07 + 0.012 * H
            pm2.x = cx + (pm2.x - cx) * 1.12
            pm2.y = cy + (pm2.y - cy) * 1.12
            smid.append(pm2)
        apex = Vector((cx, cy, za))
        verts = rim + mid + [apex]
        faces, fcols = [], []
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((j, j2, seg + j2, seg + j))
            fcols.append(shade(g_mid if j % 2 else g_dark, k))
            faces.append((seg + j, seg + j2, 2 * seg))
            fcols.append(shade(g_lite if j % 2 else g_mid, k))
        faces.append(tuple(reversed(range(seg))))
        fcols.append(shade(g_dark, 0.6))
        mb.add(verts, faces, None, facecols=fcols)
        sap = Vector((cx, cy, za + 0.1 + 0.01 * H))
        verts = srim + smid + [sap]
        cols = [snow_lo] * seg + [snow_hi] * seg + [snow_hi]
        faces = []
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((j, j2, seg + j2, seg + j))
            faces.append((seg + j, seg + j2, 2 * seg))
        faces.append(tuple(reversed(range(seg))))
        mb.add(verts, faces, cols, smooth=True)
    return mb.build(name)


# ---------------------------------------------------------------- Felsen
def make_rock(name, seed, size):
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    off = Vector((rnd.random() * 20, rnd.random() * 20, rnd.random() * 20))
    for v in bm.verts:
        d = v.co.normalized()
        n = noise.noise(d * 1.1 + off) * 0.42 + noise.noise(d * 2.7 + off) * 0.16
        v.co = d * (1 + n)
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
        v.co.z = max(v.co.z, -0.3 * size[2])
    bm.normal_update()
    verts = [v.co.copy() for v in bm.verts]
    idx = {v: i for i, v in enumerate(bm.verts)}
    faces, fcols = [], []
    r1, r2, r3 = srgb('#737882'), srgb('#5a5f69'), srgb('#878b93')
    snow = srgb('#f6f9ff')
    for f in bm.faces:
        faces.append([idx[v] for v in f.verts])
        c = f.calc_center_median()
        if f.normal.z > 0.52 and c.z > 0.05 * size[2]:
            fcols.append(shade(snow, 0.94 + 0.06 * rnd.random()))
        else:
            fcols.append(shade(rnd.choice([r1, r2, r3]), 0.85 + 0.3 * rnd.random()))
    bm.free()
    mb = MB()
    mb.add(verts, faces, None, facecols=fcols)
    return mb.build(name)


# ---------------------------------------------------------------- Skifahrer (Einzelteile, Gelenk im Ursprung)
JACKET, JACKET2, STRIPE = srgb('#ff5a1f'), srgb('#d93d0c'), srgb('#ffe9c9')
PANTS, PANTS2 = srgb('#1c2744'), srgb('#141c33')
SKIN, GLOVE, HELMET = srgb('#e8b08a'), srgb('#14171d'), srgb('#f4f5f7')
BOOT, BOOT2 = srgb('#2a2e38'), srgb('#ff7a2e')
LENS = srgb('#27c3ff')


def make_skier():
    S = 14
    # Becken
    mb = MB()
    v, f, c = lathe([(-0.12, 0.10, 0.085), (-0.08, 0.14, 0.105), (0.0, 0.158, 0.118), (0.06, 0.155, 0.115), (0.10, 0.13, 0.10)],
                    seg=S, cols=[PANTS2, PANTS, PANTS, PANTS, PANTS])
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_Pelvis")
    # Oberkörper (Ursprung = Taille)
    mb = MB()
    rings = [(-0.04, 0.13, 0.10), (0.0, 0.158, 0.118), (0.07, 0.165, 0.122), (0.15, 0.172, 0.125), (0.23, 0.185, 0.13),
             (0.29, 0.195, 0.132), (0.34, 0.198, 0.13), (0.40, 0.19, 0.122), (0.45, 0.16, 0.108), (0.49, 0.10, 0.085),
             (0.52, 0.066, 0.066), (0.56, 0.062, 0.062)]
    cols = [JACKET2, JACKET2, JACKET, JACKET, JACKET, STRIPE, STRIPE, JACKET, JACKET, JACKET, JACKET2, JACKET2]
    v, f, c = lathe(rings, seg=S, cols=cols)
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_Torso")
    # Kopf (Ursprung = Halsansatz)
    mb = MB()
    v, f, _ = lathe([(-0.03, 0.045), (0.07, 0.048)], seg=10)
    mb.add(v, f, SKIN, smooth=True)
    rings = sphere_rings(0.175, 0.122, 0.138, 0.13, n=10, oy=0.01)
    v, f, _ = lathe(rings, seg=20)
    cols = []
    dark = srgb('#20242c')
    for p in v:
        if p[1] > 0.075 and p[2] < 0.15:
            cols.append(SKIN)
        elif abs(p[0]) < 0.022 and p[2] > 0.15:
            cols.append(JACKET)
        else:
            cols.append(HELMET)
    mb.add(v, f, cols, smooth=True)
    # Brillenband + Glas
    v, f, _ = lathe([(0.155, 0.127, 0.144, 0, 0.01), (0.20, 0.126, 0.143, 0, 0.01)], seg=20)
    mb.add(v, f, dark, smooth=True)
    v, f, _ = lathe(sphere_rings(0.178, 0.092, 0.04, 0.042, n=6, oy=0.125), seg=14)
    mb.add(v, f, LENS, smooth=True)
    v, f, _ = lathe(sphere_rings(0.178, 0.102, 0.03, 0.052, n=6, oy=0.118), seg=14)
    mb.add(v, f, dark, smooth=True)
    mb.build("Sk_Head")
    # Oberarm
    mb = MB()
    v, f, c = lathe([(-0.33, 0.035), (-0.30, 0.05), (-0.15, 0.058), (-0.02, 0.068), (0.03, 0.06), (0.06, 0.035)], seg=10,
                    cols=[JACKET] * 6)
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_UpperArm")
    # Unterarm + Handschuh
    mb = MB()
    v, f, c = lathe([(-0.385, 0.028), (-0.36, 0.05), (-0.30, 0.055), (-0.275, 0.05), (-0.265, 0.045), (-0.13, 0.05),
                     (0.0, 0.052), (0.03, 0.03)], seg=10,
                    cols=[GLOVE, GLOVE, GLOVE, GLOVE, JACKET2, JACKET, JACKET, JACKET])
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_ForeArm")
    # Oberschenkel
    mb = MB()
    v, f, c = lathe([(-0.48, 0.05), (-0.45, 0.072), (-0.22, 0.086), (0.0, 0.098), (0.05, 0.085), (0.08, 0.05)], seg=12,
                    cols=[PANTS] * 6)
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_Thigh")
    # Unterschenkel
    mb = MB()
    v, f, c = lathe([(-0.42, 0.055), (-0.38, 0.062), (-0.2, 0.07), (0.0, 0.076), (0.04, 0.065), (0.07, 0.04)], seg=12,
                    cols=[PANTS2, PANTS, PANTS, PANTS, PANTS, PANTS])
    mb.add(v, f, c, smooth=True)
    mb.build("Sk_Shin")
    # Skischuh (Ursprung = Sohlenmitte unter dem Knöchel)
    mb = MB()
    v, f = box(0.105, 0.31, 0.10, (0, 0.025, 0.05))
    mb.add(v, f, BOOT)
    v, f = box(0.09, 0.10, 0.05, (0, 0.14, 0.035))
    mb.add(v, f, BOOT)
    v, f, _ = lathe([(0.07, 0.056, 0.075, 0, -0.02), (0.18, 0.058, 0.072, 0, 0.0), (0.30, 0.062, 0.07, 0, 0.022),
                     (0.33, 0.058, 0.066, 0, 0.026)], seg=10)
    mb.add(v, f, BOOT, smooth=True)
    for z, y in ((0.14, 0.05), (0.23, 0.065)):
        v, f = box(0.125, 0.03, 0.022, (0, y, z))
        mb.add(v, f, BOOT2)
    v, f = box(0.112, 0.03, 0.02, (0, 0.10, 0.092))
    mb.add(v, f, BOOT2)
    ob = mb.build("Sk_Boot")
    bevel(ob, 0.012)
    # Ski (Ursprung = Bindungsmitte, Lauffläche bei z=0)
    mb = MB()
    n = 34
    top, top2, base, white = srgb('#12c4ae'), srgb('#0a8f86'), srgb('#0d0f13'), srgb('#f3f6fa')
    verts, cols = [], []
    for i in range(n + 1):
        y = -0.80 + 1.74 * i / n
        if y < 0:
            hw = 0.037 + (0.049 - 0.037) * min(1, (-y / 0.72)) ** 1.6
        else:
            hw = 0.037 + (0.056 - 0.037) * min(1, (y / 0.74)) ** 1.6
        if y > 0.80:
            hw *= max(0.25, math.sqrt(max(0, 1 - ((y - 0.80) / 0.145) ** 2)))
        if y < -0.76:
            hw *= 0.8
        z = 0.0
        if y > 0.70:
            z = ((y - 0.70) / 0.24) ** 2 * 0.10
        if y < -0.70:
            z = ((-y - 0.70) / 0.10) ** 2 * 0.02
        th = 0.012 + 0.008 * max(0, 1 - abs(y) / 0.5)
        if y > 0.6:
            ct = white
        elif -0.45 < y < -0.38 or 0.42 < y < 0.47:
            ct = white
        elif y < -0.45:
            ct = top2
        else:
            ct = top
        verts += [(-hw, y, z), (hw, y, z), (hw, y, z + th), (-hw, y, z + th)]
        cols += [base, base, ct, ct]
    faces = []
    for i in range(n):
        a, b = i * 4, (i + 1) * 4
        for k in range(4):
            k2 = (k + 1) % 4
            faces.append((a + k, a + k2, b + k2, b + k))
    faces.append((0, 1, 2, 3))
    faces.append((n * 4, n * 4 + 1, n * 4 + 2, n * 4 + 3))
    mb.add(verts, faces, cols)
    bind = srgb('#30343d')
    for y, sy, sz in ((0.19, 0.11, 0.045), (-0.17, 0.13, 0.055)):
        v, f = box(0.07, sy, sz, (0, y, 0.02 + sz / 2))
        mb.add(v, f, bind)
    v, f = box(0.075, 0.42, 0.012, (0, 0.01, 0.026))
    mb.add(v, f, BOOT2)
    mb.build("Sk_Ski")
    # Stock (Ursprung = Griff)
    mb = MB()
    v, f, _ = lathe([(-1.16, 0.004), (-1.10, 0.008), (-0.14, 0.009)], seg=6)
    mb.add(v, f, srgb('#ffd23f'))
    v, f, _ = lathe([(-0.15, 0.014), (-0.02, 0.018), (0.02, 0.02), (0.035, 0.012)], seg=8)
    mb.add(v, f, GLOVE, smooth=True)
    v, f, _ = lathe([(-1.085, 0.045), (-1.075, 0.045)], seg=10)
    mb.add(v, f, srgb('#20242c'))
    mb.build("Sk_Pole")


# ---------------------------------------------------------------- Tore, Markierungen
def make_gate(name, col):
    mb = MB()
    c = srgb(col)
    for x in (-0.38, 0.38):
        v, f, _ = lathe([(-0.3, 0.017), (1.8, 0.017)], seg=7)
        mb.add(v, f, shade(c, 0.9), smooth=True, M=Matrix.Translation((x, 0, 0)))
        v, f, _ = lathe([(1.8, 0.02), (1.84, 0.012)], seg=7)
        mb.add(v, f, srgb('#f3f6fa'), smooth=True, M=Matrix.Translation((x, 0, 0)))
    v, f = box(0.74, 0.012, 0.62, (0, 0, 1.42))
    mb.add(v, f, c)
    for y in (-0.008, 0.008):
        v, f = box(0.34, 0.004, 0.2, (0, y, 1.42))
        mb.add(v, f, srgb('#f3f6fa'))
    return mb.build(name)


def make_marker():
    mb = MB()
    o, w, k = srgb('#ff6a13'), srgb('#f3f6fa'), srgb('#15181d')
    v, f, c = lathe([(-0.4, 0.03), (1.15, 0.03), (1.15, 0.034), (1.3, 0.034), (1.3, 0.03), (1.5, 0.03), (1.56, 0.02)],
                    seg=8, cols=[o, o, k, k, o, o, o])
    mb.add(v, f, c, smooth=True)
    v, f, _ = lathe([(1.6, 0.12), (1.62, 0.12)], seg=12)
    M = Matrix.Translation((0, 0, 1.6)) @ Matrix.Rotation(math.radians(90), 4, 'X') @ Matrix.Translation((0, 0, -1.61))
    mb.add(v, f, o, M=M)
    return mb.build("PisteMarker")


# ---------------------------------------------------------------- Lift
def make_pylon():
    mb = MB()
    steel, steel2, dark, orange = srgb('#97a3ae'), srgb('#7c8791'), srgb('#262a31'), srgb('#ff6a13')
    v, f = box(1.7, 1.7, 1.2, (0, 0, -0.2))
    mb.add(v, f, srgb('#a9aba8'))
    v, f, c = lathe([(0.3, 0.40), (3.0, 0.36), (3.0, 0.365), (3.6, 0.36), (3.6, 0.35), (11.2, 0.24)], seg=10,
                    cols=[steel, steel, orange, orange, steel, steel2])
    mb.add(v, f, c, smooth=True)
    v, f = box(5.6, 0.34, 0.34, (0, 0, 11.2))
    mb.add(v, f, steel2)
    v, f = box(0.5, 0.5, 0.5, (0, 0, 11.2))
    mb.add(v, f, steel)
    for x in (-2.6, 2.6):
        v, f = box(0.16, 2.6, 0.2, (x, 0, 10.85))
        mb.add(v, f, steel2)
        v, f = box(0.12, 0.12, 0.4, (x, 0, 11.0))
        mb.add(v, f, steel2)
        for y in (-1.05, -0.35, 0.35, 1.05):
            v, f, _ = lathe([(-0.06, 0.2), (0.06, 0.2)], seg=10)
            M = Matrix.Translation((x, y, 10.68)) @ Matrix.Rotation(math.radians(90), 4, 'Y')
            mb.add(v, f, dark, M=M)
    # Leiter
    v, f = box(0.06, 0.06, 10.4, (0.2, -0.42, 5.6))
    mb.add(v, f, steel2)
    v, f = box(0.06, 0.06, 10.4, (-0.2, -0.42, 5.6))
    mb.add(v, f, steel2)
    ob = mb.build("LiftPylon")
    return ob


def make_chair():
    mb = MB()
    fr, seat, seat2 = srgb('#3b414b'), srgb('#e4572e'), srgb('#b93d1b')
    v, f = box(0.22, 0.5, 0.16, (0, 0, 0.0))
    mb.add(v, f, fr)
    v, f = box(0.07, 0.07, 2.25, (0, 0, -1.15))
    mb.add(v, f, fr)
    v, f = box(2.2, 0.07, 0.07, (0, 0, -2.28))
    mb.add(v, f, fr)
    for x in (-1.06, 1.06):
        v, f = box(0.05, 0.05, 0.95, (x, -0.02, -2.74))
        mb.add(v, f, fr)
        v, f = box(0.05, 0.62, 0.05, (x, 0.24, -3.2))
        mb.add(v, f, fr)
        v, f = box(0.04, 0.04, 0.5, (x, 0.52, -3.44))
        mb.add(v, f, fr)
    v, f = box(2.1, 0.52, 0.09, (0, 0.2, -3.14))
    mb.add(v, f, seat)
    M = Matrix.Translation((0, -0.07, -2.82)) @ Matrix.Rotation(math.radians(-10), 4, 'X')
    v, f = box(2.1, 0.08, 0.62, (0, 0, 0))
    mb.add(v, f, seat2, M=M)
    v, f = box(2.12, 0.05, 0.05, (0, 0.52, -3.68))
    mb.add(v, f, fr)
    v, f = box(2.2, 0.04, 0.04, (0, 0.5, -2.75))
    mb.add(v, f, fr)
    ob = mb.build("LiftChair")
    bevel(ob, 0.015, 1)
    return ob


# ---------------------------------------------------------------- Gebäude
def roof(mb, hw, zb, rise, y0, y1, wood, snow, snow_th=0.45):
    for sx in (-1, 1):
        pts = [(sx * (hw + 0.7), zb - 0.42), (0, zb + rise), (0, zb + rise + 0.2), (sx * (hw + 0.7), zb - 0.22)]
        v, f = extrude_xz(pts, y0 - 0.5, y1 + 0.5)
        mb.add(v, f, wood)
        pts = [(sx * (hw + 0.86), zb - 0.30), (sx * 0.0, zb + rise + 0.2), (sx * 0.0, zb + rise + 0.2 + snow_th * 1.1),
               (sx * (hw * 0.5), zb + rise * 0.5 + snow_th * 1.25), (sx * (hw + 0.86), zb + snow_th * 0.55 - 0.2)]
        v, f = extrude_xz(pts, y0 - 0.66, y1 + 0.66)
        mb.add(v, f, snow, smooth=False)


def make_chalet():
    mb = MB()
    stone, wood, wood2, dwood = srgb('#8d8f92'), srgb('#8a5630'), srgb('#734523'), srgb('#4a2f1c')
    snow, win, door = srgb('#f6f9ff'), srgb('#ffd27a'), srgb('#3b2416')
    v, f = box(8.3, 6.3, 1.4, (0, 0, 0.0))
    mb.add(v, f, stone)
    for i in range(7):
        z = 0.7 + 0.2 + i * 0.4
        v, f = box(8.0 + (0.12 if i % 2 else 0), 6.0 + (0 if i % 2 else 0.12), 0.4, (0, 0, z))
        mb.add(v, f, wood if i % 2 else wood2)
    v, f = extrude_xz([(-4, 3.5), (4, 3.5), (0, 5.9)], -3, 3)
    mb.add(v, f, wood2)
    roof(mb, 4.0, 3.5, 2.4, -3, 3, dwood, snow)
    v, f = box(0.75, 0.75, 2.0, (2.1, 0.9, 5.3))
    mb.add(v, f, stone)
    v, f = box(0.95, 0.95, 0.28, (2.1, 0.9, 6.42))
    mb.add(v, f, snow)
    for x in (-2.4, 2.4):
        v, f = box(1.15, 0.12, 1.05, (x, -3.04, 2.2))
        mb.add(v, f, win)
        v, f = box(1.35, 0.08, 0.1, (x, -3.06, 1.62))
        mb.add(v, f, dwood)
        v, f = box(0.06, 0.14, 1.05, (x, -3.05, 2.2))
        mb.add(v, f, dwood)
        v, f = box(0.12, 1.1, 1.0, (4.04 * (1 if x > 0 else -1), 0.3, 2.2))
        mb.add(v, f, win)
    v, f = box(1.0, 0.12, 0.9, (0, -3.04, 4.3))
    mb.add(v, f, win)
    v, f = box(1.05, 0.12, 1.95, (0, -3.04, 1.68))
    mb.add(v, f, door)
    v, f = box(8.2, 1.0, 0.14, (0, -3.5, 3.3))
    mb.add(v, f, dwood)
    v, f = box(8.2, 0.08, 0.1, (0, -3.96, 4.05))
    mb.add(v, f, dwood)
    for i in range(12):
        v, f = box(0.08, 0.06, 0.75, (-4.0 + i * 8 / 11, -3.96, 3.7))
        mb.add(v, f, wood)
    v, f = box(8.3, 1.1, 0.16, (0, -3.5, 3.42))
    mb.add(v, f, snow)
    return mb.build("Chalet")


def make_start_hut():
    mb = MB()
    wood, wood2, dwood, snow, orange = srgb('#8a5630'), srgb('#734523'), srgb('#4a2f1c'), srgb('#f6f9ff'), srgb('#ff6a13')
    v, f = box(4.4, 4.0, 1.2, (0, -0.4, -0.4))
    mb.add(v, f, dwood)
    for i in range(6):
        z = 0.2 + 0.2 + i * 0.4
        c = wood if i % 2 else wood2
        v, f = box(4.2, 0.2, 0.4, (0, -2.2, z))
        mb.add(v, f, c)
        for x in (-2.0, 2.0):
            v, f = box(0.2, 3.2 + (0.1 if i % 2 else 0), 0.4, (x, -0.7, z))
            mb.add(v, f, c)
    v, f = extrude_xz([(-2.1, 2.6), (2.1, 2.6), (0, 3.7)], -2.3, -2.1)
    mb.add(v, f, wood2)
    roof(mb, 2.1, 2.6, 1.1, -2.2, 1.0, dwood, snow, 0.32)
    for x in (-2.0, 2.0):
        v, f = box(0.16, 0.16, 2.4, (x, 0.95, 1.4))
        mb.add(v, f, dwood)
    for x in (-0.75, 0.75):
        v, f = box(0.08, 0.08, 1.0, (x, 1.5, 0.5))
        mb.add(v, f, orange)
    return mb.build("StartHut")


def make_arch():
    mb = MB()
    red, white, dark = srgb('#e4252b'), srgb('#f6f9ff'), srgb('#22262d')
    n, seg, rad = 44, 12, 0.8
    pts = []
    for i in range(n + 1):
        th = math.pi * (1 - i / n)
        c, s = math.cos(th), math.sin(th)
        x = 9.0 * (1 if c >= 0 else -1) * abs(c) ** 0.55
        z = 7.2 * abs(s) ** 0.55
        pts.append(Vector((x, 0, z)))
    verts, cols = [], []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(n, i + 1)]
        T = (b - a).normalized()
        N1 = Vector((0, 1, 0))
        N2 = T.cross(N1).normalized()
        col = red if (i // 4) % 2 == 0 else white
        for j in range(seg):
            ph = j / seg * 6.2832
            verts.append(p + rad * (math.cos(ph) * N1 + math.sin(ph) * N2))
            cols.append(col)
    faces = []
    for i in range(n):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    faces.append(tuple(range(seg)))
    faces.append(tuple(n * seg + j for j in range(seg)))
    mb.add(verts, faces, cols, smooth=True)
    for x in (-9.0, 9.0):
        v, f = box(2.2, 2.2, 0.8, (x, 0, 0.0))
        mb.add(v, f, dark)
    return mb.build("FinishArch")


def make_fence():
    """Fangzaun-Pfosten (Netz wird im Spiel als Textur ergänzt)."""
    mb = MB()
    v, f, _ = lathe([(-0.3, 0.025), (1.5, 0.025)], seg=6)
    mb.add(v, f, srgb('#ff6a13'), smooth=True)
    return mb.build("FencePost")


def build_all():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)
    make_tree("TreeA", 11, 11.0, 2.9, 7)
    make_tree("TreeB", 23, 8.0, 2.5, 6)
    make_tree("TreeC", 37, 14.0, 3.2, 9)
    make_rock("RockA", 5, (1.6, 1.3, 1.1))
    make_rock("RockB", 9, (2.4, 1.7, 1.3))
    make_rock("RockC", 14, (1.1, 1.2, 0.8))
    make_skier()
    make_gate("GateRed", '#e3202b')
    make_gate("GateBlue", '#1763e6')
    make_marker()
    make_pylon()
    make_chair()
    make_chalet()
    make_start_hut()
    make_arch()
    make_fence()
    return [o.name for o in bpy.data.objects]


def export(path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.location = (0, 0, 0)
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_animations=False)
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'ACTIVE'
    if 'export_all_vertex_colors' in props:
        kw['export_all_vertex_colors'] = False
    if 'export_active_vertex_color_when_no_material' in props:
        kw['export_active_vertex_color_when_no_material'] = True
    if 'export_materials' in props:
        kw['export_materials'] = 'EXPORT'
    bpy.ops.export_scene.gltf(**kw)
    return kw
