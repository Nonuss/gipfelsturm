# Skifahrer v3 nach Referenzbild: dunkelblaue Jacke mit orangen Flächen und hohem Kragen, weite Cargo-Hose,
# schwarzer Helm, verspiegelte Brille, graue Schuhe mit orangen Schnallen.
# Wird NACH blender_build.py ausgeführt und ersetzt make_skier() und export().
#
# Der Körper ist kein Satz starrer Einzelteile mehr, sondern zusammenhängende Schläuche in Ruhehaltung.
# Jeder Punkt trägt zwei Knochen-Gewichte (_b0, _b1, _w0) – das Spiel verformt die Figur damit weich an den Gelenken.
import math
import bmesh
import bpy
from mathutils import Vector, Matrix, noise

PEL, CH, HD, THL, SHL, THR, SHR, UAL, FAL, UAR, FAR = range(11)


def g(s):
    return (s, s, s, 1.0)


def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


class SMB:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")
        self.l0 = self.bm.verts.layers.float.new("_b0")
        self.l1 = self.bm.verts.layers.float.new("_b1")
        self.lw = self.bm.verts.layers.float.new("_w0")

    def add(self, verts, faces, color, skin, smooth=True, M=None, pick=None, wr=None):
        loc = [Vector(v) for v in verts]
        bv = []
        for p in loc:
            q = p.copy()
            if wr:
                n = noise.noise(p * wr[1] + Vector((wr[2], wr[2] * 1.7, wr[2] * 0.3)))
                r = Vector((p.x, p.y, 0))
                if r.length > 1e-4:
                    q += r.normalized() * n * wr[0]
            sk = skin(p) if callable(skin) else skin
            if M is not None:
                q = M @ q
            v = self.bm.verts.new(q)
            v[self.l0], v[self.l1], v[self.lw] = sk
            bv.append(v)
        for f in faces:
            if len(set(f)) < 3:
                continue
            if pick is not None:
                c = sum((loc[i] for i in f), Vector()) / len(f)
                if not pick(c):
                    continue
            try:
                face = self.bm.faces.new([bv[i] for i in f])
            except ValueError:
                continue
            face.smooth = smooth
            for k, loop in enumerate(face.loops):
                loop[self.col] = color[f[k]] if isinstance(color, list) else color

    def build(self, name):
        bmesh.ops.delete(self.bm, geom=[v for v in self.bm.verts if not v.link_faces], context='VERTS')
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.color_attributes.render_color_index = 0
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        ob.data.materials.append(get_mat())
        return ob


# Rumpf-Profil (z, rx, ry) in Körperkoordinaten – wird auch für aufgesetzte Details gebraucht
TORSO = [(0.84, 0.234, 0.182), (0.875, 0.241, 0.189), (0.91, 0.234, 0.182), (0.915, 0.224, 0.174), (1.0, 0.208, 0.164),
         (1.07, 0.205, 0.160), (1.2, 0.215, 0.165), (1.33, 0.228, 0.168), (1.43, 0.232, 0.162), (1.49, 0.215, 0.150),
         (1.535, 0.165, 0.130), (1.57, 0.125, 0.120), (1.585, 0.118, 0.122)]


def torso_r(z):
    for a, b in zip(TORSO, TORSO[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t
    return TORSO[-1][1], TORSO[-1][2]


def torso_skin(p):
    z = p.z
    if z < 0.935 and p.y > 0.04:
        return (PEL, THL if p.x < 0 else THR, 0.62)
    if z < 1.0:
        return (PEL, PEL, 1.0)
    if z < 1.22:
        return (CH, PEL, sstep(1.0, 1.22, z))
    return (CH, CH, 1.0)


def make_skier():
    DARK, BLACK = srgb('#191b20'), srgb('#131417')
    SKIN = srgb('#e0a482')
    ACC = srgb('#ff6a13')
    HI = g(1.0)
    S = 24

    jacket, accent, pants, fixed = SMB(), SMB(), SMB(), SMB()

    # ============================================================ Hose
    for side, TH, SH in ((-1, THL, SHL), (1, THR, SHR)):
        M = Matrix.Translation((side * 0.10, 0, 0.96))
        rings = [(-0.935, 0.066, 0.076, 0, 0.02), (-0.93, 0.090, 0.102, 0, 0.02), (-0.885, 0.093, 0.106, 0, 0.02),
                 (-0.865, 0.118, 0.128, 0, 0.016), (-0.78, 0.126, 0.134, 0, 0.012), (-0.62, 0.118, 0.124, 0, 0.004),
                 (-0.45, 0.113, 0.119), (-0.30, 0.119, 0.125), (-0.13, 0.122, 0.13), (0.0, 0.112, 0.126), (0.06, 0.085, 0.10)]
        cols = [g(0.45), g(0.72), g(0.72), HI, HI, HI, HI, HI, HI, HI, HI]
        v, f, c = lathe(rings, seg=18, cols=cols)

        def leg_skin(p, TH=TH, SH=SH):
            return (TH, SH, sstep(-0.45 - 0.10, -0.45 + 0.10, p.z))
        pants.add(v, f, c, leg_skin, M=M, wr=(0.009, 9.0, 2.0 + side))
        # Cargotasche außen am Oberschenkel
        v, f = box(0.03, 0.15, 0.18, (side * 0.122, -0.005, -0.27))
        pants.add(v, f, g(0.86), (TH, TH, 1.0), smooth=False, M=M)
        v, f = box(0.036, 0.158, 0.05, (side * 0.124, -0.005, -0.195))
        pants.add(v, f, g(0.78), (TH, TH, 1.0), smooth=False, M=M)

    def seat_skin(p):
        if p.z < 0.90:
            return (PEL, THL if p.x < 0 else THR, 0.5 + 0.5 * sstep(0.78, 0.90, p.z))
        return (PEL, PEL, 1.0)
    v, f, _ = lathe([(0.78, 0.09, 0.085), (0.84, 0.166, 0.136), (0.93, 0.182, 0.146), (1.04, 0.176, 0.14), (1.09, 0.15, 0.12)], seg=18)
    pants.add(v, f, HI, seat_skin, wr=(0.006, 9.0, 1.0))
    pants.build("Sk_Pants")

    # ============================================================ Jacke (Hauptfarbe + orange Flächen)
    def is_accent(c):
        if c.z < 0.912 or c.z > 1.583:
            return True
        if c.y > 0.05 and -0.09 < c.x < 0.04:
            return True
        if c.y > 0.02 and -0.205 < c.x <= -0.09 and 1.27 < c.z < 1.47:
            return True
        return False
    rings = [(0.835, 0.20, 0.15)] + TORSO + [(1.60, 0.115, 0.125, 0, 0.005), (1.725, 0.112, 0.128, 0, 0.012),
                                               (1.725, 0.092, 0.108, 0, 0.012), (1.62, 0.09, 0.10, 0, 0.008)]
    v, f, _ = lathe(rings, seg=S)
    jacket.add(v, f, HI, torso_skin, pick=lambda c: not is_accent(c), wr=(0.006, 8.0, 5.0))
    accent.add(v, f, HI, torso_skin, pick=is_accent, wr=(0.006, 8.0, 5.0))

    for side, UA, FA in ((-1, UAL, FAL), (1, UAR, FAR)):
        d0 = Vector((side * 0.42, 0, -0.9075)).normalized()
        Z = -d0
        Y = Vector((0, 1, 0))
        X = Y.cross(Z).normalized()
        M = Matrix(((X.x, Y.x, Z.x, side * 0.215), (X.y, Y.y, Z.y, 0), (X.z, Y.z, Z.z, 1.51), (0, 0, 0, 1)))
        rings = [(-0.60, 0.05), (-0.595, 0.072), (-0.56, 0.074), (-0.55, 0.085), (-0.42, 0.093), (-0.31, 0.094),
                 (-0.16, 0.102), (-0.04, 0.106), (0.01, 0.09), (0.045, 0.045)]
        v, f, _ = lathe(rings, seg=16)

        def arm_skin(p, UA=UA, FA=FA):
            return (UA, FA, sstep(-0.31 - 0.08, -0.31 + 0.08, p.z))

        def stripe(c):
            return c.y < -0.052 and -0.555 < c.z < -0.03
        jacket.add(v, f, HI, arm_skin, M=M, pick=lambda c: not stripe(c), wr=(0.006, 10.0, 7.0 + side))
        accent.add(v, f, HI, arm_skin, M=M, pick=stripe, wr=(0.006, 10.0, 7.0 + side))
        # Ärmelbund + Handschuh
        v, f, _ = lathe([(-0.60, 0.064), (-0.596, 0.077), (-0.572, 0.078), (-0.568, 0.07)], seg=16)
        fixed.add(v, f, DARK, (FA, FA, 1.0), M=M)
        v, f, _ = lathe([(-0.635, 0.05), (-0.60, 0.058), (-0.585, 0.058)], seg=12)
        fixed.add(v, f, BLACK, (FA, FA, 1.0), M=M)
        v, f, _ = lathe(sphere_rings(-0.685, 0.05, 0.04, 0.075, n=7), seg=12)
        fixed.add(v, f, BLACK, (FA, FA, 1.0), M=M)
        v, f, _ = lathe(sphere_rings(-0.665, 0.022, 0.026, 0.04, n=5, oy=0.042), seg=8)
        fixed.add(v, f, BLACK, (FA, FA, 1.0), M=M)

    jacket.build("Sk_Jacket")
    accent.build("Sk_JacketAcc")

    # ============================================================ Feste Teile: Reißverschluss, Hals, Kopf
    def strip(x0, x1, z0, z1, col, n=14):
        vs, fs = [], []
        for i in range(n + 1):
            z = z0 + (z1 - z0) * i / n
            rx, ry = torso_r(z)
            xm = (x0 + x1) / 2
            y = ry * math.sqrt(max(0.05, 1 - (xm / rx) ** 2))
            vs += [(x0, y + 0.006, z), (x1, y + 0.006, z), (x1, y - 0.012, z), (x0, y - 0.012, z)]
        for i in range(n):
            a, b = i * 4, (i + 1) * 4
            for k in range(4):
                k2 = (k + 1) % 4
                fs.append((a + k, a + k2, b + k2, b + k))
        fs.append((3, 2, 1, 0))
        fs.append((n * 4, n * 4 + 1, n * 4 + 2, n * 4 + 3))
        fixed.add(vs, fs, col, torso_skin, smooth=False)
    strip(0.034, 0.048, 0.86, 1.585, DARK)
    strip(-0.152, -0.142, 1.30, 1.44, DARK, n=4)
    strip(0.10, 0.108, 0.95, 1.10, DARK, n=4)
    strip(-0.168, -0.16, 0.95, 1.10, DARK, n=4)
    # Reißverschluss am Kragen
    v, f = box(0.014, 0.012, 0.13, (0.041, 0.135, 1.655))
    fixed.add(v, f, DARK, (CH, CH, 1.0), smooth=False)

    v, f, _ = lathe([(1.54, 0.072), (1.63, 0.068), (1.70, 0.073, 0.082, 0, 0.01)], seg=14)
    fixed.add(v, f, BLACK, lambda p: (HD, CH, sstep(1.58, 1.68, p.z)))

    NZ = 1.63
    HELM = srgb('#1b1d21')
    H = (HD, HD, 1.0)
    v, f, _ = lathe(sphere_rings(NZ + 0.19, 0.129, 0.147, 0.139, n=12, oy=0.008), seg=24)
    cols = []
    for p in v:
        zr = p[2] - NZ
        if p[1] > 0.06 and zr < 0.122:
            cols.append(BLACK)
        elif p[1] > 0.088 and zr < 0.17:
            cols.append(SKIN)
        else:
            cols.append(HELM)
    fixed.add(v, f, cols, H)
    v, f, _ = lathe(sphere_rings(NZ + 0.14, 0.02, 0.02, 0.022, n=5, oy=0.148), seg=8)
    fixed.add(v, f, SKIN, H)
    for x in (-0.119, 0.119):
        v, f, _ = lathe(sphere_rings(NZ + 0.155, 0.03, 0.052, 0.058, n=6, ox=x), seg=10)
        fixed.add(v, f, HELM, H)
    v, f = box(0.17, 0.05, 0.014, (0, 0.137, NZ + 0.262))
    fixed.add(v, f, HELM, H, smooth=False)
    for x in (-0.05, 0.0, 0.05):
        v, f = box(0.022, 0.12, 0.012, (x, 0.01, NZ + 0.326 - abs(x) * 0.22))
        fixed.add(v, f, srgb('#0c0d0f'), H, smooth=False)
    v, f = box(0.05, 0.02, 0.035, (0, -0.142, NZ + 0.19))
    fixed.add(v, f, srgb('#0c0d0f'), H, smooth=False)
    # Brille: Band, Rahmen, verspiegeltes Glas (oben orange, unten blau)
    v, f, _ = lathe([(NZ + 0.168, 0.134, 0.152, 0, 0.008), (NZ + 0.216, 0.133, 0.151, 0, 0.008)], seg=24)
    fixed.add(v, f, BLACK, H)
    v, f, _ = lathe(sphere_rings(NZ + 0.192, 0.114, 0.037, 0.062, n=7, oy=0.121), seg=16)
    fixed.add(v, f, BLACK, H)
    v, f, _ = lathe(sphere_rings(NZ + 0.193, 0.1, 0.037, 0.049, n=8, oy=0.132), seg=18)
    lens_o, lens_b = srgb('#ff8a12'), srgb('#1f7dff')
    cols = [mixc(lens_b, lens_o, sstep(NZ + 0.165, NZ + 0.215, p[2])) for p in v]
    lens = SMB()
    lens.add(v, f, cols, H)
    lens.build("Sk_Lens")
    fixed.build("Sk_Fixed")

    # ============================================================ Starre Teile
    mb = MB()
    SHELL, SOLE = srgb('#6f747d'), srgb('#25272c')
    v, f = box(0.118, 0.33, 0.03, (0, 0.025, 0.015))
    mb.add(v, f, SOLE)
    v, f = box(0.112, 0.31, 0.085, (0, 0.025, 0.07))
    mb.add(v, f, SHELL)
    v, f = box(0.098, 0.10, 0.05, (0, 0.15, 0.05))
    mb.add(v, f, SHELL)
    v, f, _ = lathe([(0.08, 0.06, 0.08, 0, -0.02), (0.18, 0.062, 0.076, 0, 0.0), (0.30, 0.066, 0.074, 0, 0.022), (0.335, 0.062, 0.07, 0, 0.026)], seg=12)
    mb.add(v, f, SHELL, smooth=True)
    for z, y in ((0.13, 0.055), (0.2, 0.066), (0.27, 0.075)):
        v, f = box(0.134, 0.028, 0.02, (0, y, z))
        mb.add(v, f, ACC)
    v, f = box(0.12, 0.028, 0.02, (0, 0.11, 0.105))
    mb.add(v, f, ACC)
    v, f, _ = lathe([(0.30, 0.069, 0.077, 0, 0.022), (0.33, 0.069, 0.077, 0, 0.025)], seg=12)
    mb.add(v, f, SOLE, smooth=True)
    ob = mb.build("Sk_Boot")
    bevel(ob, 0.012)

    mb = MB()
    n = 40
    base, WHITE = srgb('#0d0f13'), srgb('#f3f6fa')
    verts, cols = [], []
    for i in range(n + 1):
        y = -0.86 + 1.74 * i / n
        ay = abs(y)
        hw = 0.046 + (0.062 - 0.046) * min(1, ay / 0.7) ** 1.6
        if ay > 0.74:
            hw *= max(0.3, math.sqrt(max(0, 1 - ((ay - 0.74) / 0.135) ** 2)))
        z = 0.0
        if y > 0.62:
            z = ((y - 0.62) / 0.26) ** 2 * 0.11
        if y < -0.64:
            z = ((-y - 0.64) / 0.22) ** 2 * 0.085
        th = 0.012 + 0.008 * max(0, 1 - ay / 0.5)
        if ay > 0.66:
            ct = ACC
        elif 0.5 < ay < 0.56 or 0.30 < y < 0.44:
            ct = WHITE
        else:
            ct = DARK
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
    for y, sy, sz in ((0.19, 0.11, 0.045), (-0.17, 0.13, 0.055)):
        v, f = box(0.07, sy, sz, (0, y, 0.02 + sz / 2))
        mb.add(v, f, srgb('#30343d'))
    mb.build("Sk_Ski")

    mb = MB()
    v, f, _ = lathe([(-1.08, 0.004), (-1.03, 0.008), (-0.14, 0.009)], seg=6)
    mb.add(v, f, srgb('#d9dde3'))
    v, f, _ = lathe([(-0.15, 0.014), (-0.02, 0.018), (0.02, 0.02), (0.035, 0.012)], seg=8)
    mb.add(v, f, DARK, smooth=True)
    v, f, _ = lathe([(-1.015, 0.05), (-1.005, 0.05)], seg=10)
    mb.add(v, f, ACC)
    mb.build("Sk_Pole")


def export(path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.location = (0, 0, 0)
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_animations=False)
    for k, val in (('export_vertex_color', 'ACTIVE'), ('export_all_vertex_colors', False), ('export_active_vertex_color_when_no_material', True),
                   ('export_materials', 'EXPORT'), ('export_attributes', True)):
        if k in props:
            kw[k] = val
    bpy.ops.export_scene.gltf(**kw)
    return {k: str(v) for k, v in kw.items()}
