# Helikopter für den Heli-Berg, angelehnt an den typischen Heli-Ski-Helikopter (AS350 B3 „Écureuil“):
# rundlicher Rumpf mit großer Glaskanzel, Seitenfenster, Schiebetür, Triebwerkshaube, schlanker Heckausleger mit
# Höhenleitwerk und Endscheiben, Seitenleitwerk, Kufen mit hochgebogenen Spitzen, Skikorb an der rechten Seite,
# Dreiblatt-Hauptrotor und Heckrotor als eigene Objekte (drehen im Spiel).
# Aufruf in Blender: exec(blender_build.py); exec(blender_heli.py); make_heli(); danach export().
# Achsen: X = Längsachse (vorne +X), Z = oben, Y = links. Ursprung = Rotormast-Fuß.
import bpy, math
from mathutils import Matrix, Vector


def _body(mb, rings, seg, colfn, smooth=True):
    """Rumpf aus Querschnitten entlang X. rings: (x, halbe Breite, halbe Höhe, z-Mitte). colfn(x, y, z, a) -> Farbe."""
    verts, cols = [], []
    for (x, ry, rz, zc) in rings:
        for j in range(seg):
            a = j / seg * 2 * math.pi
            y, z = ry * math.cos(a), zc + rz * math.sin(a)
            verts.append((x, y, z))
            cols.append(colfn(x, y, z, a))
    faces, fcols = [], []
    n = len(rings)
    for i in range(n - 1):
        for j in range(seg):
            j2 = (j + 1) % seg
            fc = (i * seg + j, (i + 1) * seg + j, (i + 1) * seg + j2, i * seg + j2)
            faces.append(fc)
            # Farbe pro Fläche (Flächenmitte): scharfe Kanten zwischen Lack, Glas und Streifen statt verlaufener Farben
            cx = sum(verts[k][0] for k in fc) / 4; cy = sum(verts[k][1] for k in fc) / 4; cz = sum(verts[k][2] for k in fc) / 4
            am = (j + 0.5) / seg * 2 * math.pi
            fcols.append(colfn(cx, cy, cz, am))
    faces.append(tuple(range(seg))[::-1]); fcols.append(colfn(*verts[0], 0))
    faces.append(tuple((n - 1) * seg + j for j in range(seg))); fcols.append(colfn(*verts[-1], 0))
    mb.add(verts, faces, None, smooth=smooth, facecols=fcols)


def _tube(mb, a, b, r, col, seg=8):
    """Rohr von Punkt a nach Punkt b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    v, f, _ = lathe([(0, r), (L, r)], seg=seg)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    M = Matrix.Translation(a) @ q.to_matrix().to_4x4()
    mb.add(v, f, col, smooth=True, M=M)


def make_heli():
    for n in ("Heli", "HeliRotor", "HeliTail"):
        ob = bpy.data.objects.get(n)
        if ob:
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
    RED, RED2, WHITE, DARK, GLASS, GLASS2, STEEL, BLACK = (srgb('#c62a1c'), srgb('#9b1f14'), srgb('#f3f5f8'), srgb('#2a2e35'),
                                                          srgb('#1b3550'), srgb('#2c5378'), srgb('#a4adb6'), srgb('#15171b'))
    YEL, SKI1, SKI2 = srgb('#f2c230'), srgb('#ff6a13'), srgb('#1f6fe5')

    mb = MB()
    # ---- Kabine: Querschnitte von hinten nach vorne (Nase tiefer, Dach hoch)
    rings = [(-2.05, 0.42, 0.42, -1.05), (-1.7, 0.8, 0.78, -1.15), (-1.1, 1.06, 0.98, -1.2), (-0.3, 1.18, 1.08, -1.22),
             (0.5, 1.2, 1.1, -1.24), (1.25, 1.14, 1.04, -1.3), (1.9, 0.98, 0.9, -1.4), (2.35, 0.75, 0.68, -1.52),
             (2.7, 0.45, 0.42, -1.65), (2.88, 0.12, 0.12, -1.72)]

    def cabin_col(x, y, z, a):
        up = math.sin(a)
        # große Glaskanzel vorne: oben und an den Seiten bis zur Nase
        if x > 0.95 and up > -0.45 and not (x > 2.6 and up < 0.0):
            return GLASS if up > 0.2 else GLASS2
        # Seitenfenster in den Türen
        if -0.9 < x < 0.85 and 0.05 < up < 0.62 and abs(y) > 0.6:
            return GLASS2
        if up < -0.55:
            return WHITE           # heller Bauch
        if -0.55 <= up < -0.4:
            return DARK            # Zierstreifen
        return RED
    _body(mb, rings, 28, cabin_col)
    # Türfugen (rechte Seite = -Y): Schiebetür-Umriss
    for (x0, x1, z0) in ((-0.95, 0.85, -0.25), (-0.95, 0.85, -2.05)):
        v, f = box(x1 - x0, 0.03, 0.035, ((x0 + x1) / 2, -1.17, z0))
        mb.add(v, f, BLACK)
    for x in (-0.95, 0.85):
        v, f = box(0.035, 0.03, 1.7, (x, -1.17, -1.15))
        mb.add(v, f, BLACK)
    # Triebwerkshaube und Mast
    hood = [(-2.3, 0.3, 0.2, -0.15), (-1.6, 0.55, 0.38, -0.05), (-0.6, 0.62, 0.42, 0.0), (0.4, 0.58, 0.38, -0.05), (0.95, 0.35, 0.22, -0.12)]
    _body(mb, hood, 20, lambda x, y, z, a: WHITE if math.sin(a) > 0.3 else RED)
    v, f, _ = lathe([(-0.05, 0.12), (0.4, 0.1)], seg=10)
    mb.add(v, f, DARK, smooth=True)
    _tube(mb, (-2.25, 0.0, -0.05), (-2.75, 0.0, 0.05), 0.16, DARK, seg=10)    # Auspuff
    # ---- Heckausleger, Höhenleitwerk mit Endscheiben, Seitenleitwerk
    boom = [(-1.95, 0.4, 0.38, -0.85), (-3.2, 0.3, 0.29, -0.78), (-4.6, 0.22, 0.21, -0.72), (-6.0, 0.16, 0.16, -0.66), (-6.7, 0.12, 0.12, -0.62)]
    _body(mb, boom, 14, lambda x, y, z, a: RED if math.sin(a) > -0.6 else WHITE)
    v, f = box(0.75, 2.3, 0.07, (-5.15, 0, -0.66))
    mb.add(v, f, RED2)
    for y in (-1.15, 1.15):
        v, f = box(0.6, 0.06, 0.55, (-5.2, y, -0.58))
        mb.add(v, f, RED2)
    # Seitenleitwerk (gepfeilt, oben und unten)
    fin = [(-6.35, -0.6), (-5.95, -0.6), (-6.55, 0.55), (-6.95, 0.55)]
    v = [(x, -0.04, z) for (x, z) in fin] + [(x, 0.04, z) for (x, z) in fin]
    mb.add(v, [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], RED2)
    fin2 = [(-6.3, -0.7), (-6.0, -0.7), (-6.4, -1.2), (-6.6, -1.2)]
    v = [(x, -0.04, z) for (x, z) in fin2] + [(x, 0.04, z) for (x, z) in fin2]
    mb.add(v, [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], RED2)
    # ---- Kufen: Längsrohre mit hochgebogener Spitze, zwei gebogene Querbügel
    for y in (-1.12, 1.12):
        _tube(mb, (-1.6, y, -2.75), (1.55, y, -2.75), 0.055, STEEL)
        _tube(mb, (1.55, y, -2.75), (2.05, y, -2.5), 0.055, STEEL)
        _tube(mb, (2.05, y, -2.5), (2.2, y, -2.28), 0.05, STEEL)
    for x in (-0.95, 1.05):
        for s in (-1, 1):
            _tube(mb, (x, s * 1.12, -2.75), (x + 0.05, s * 0.85, -2.25), 0.05, STEEL)
            _tube(mb, (x + 0.05, s * 0.85, -2.25), (x + 0.05, s * 0.45, -2.05), 0.05, STEEL)
        _tube(mb, (x + 0.05, -0.45, -2.05), (x + 0.05, 0.45, -2.05), 0.05, STEEL)
    # ---- Skikorb rechts (-Y) mit Skiern und Boards
    _tube(mb, (-1.5, -1.32, -1.85), (0.9, -1.32, -1.85), 0.035, STEEL)
    _tube(mb, (-1.5, -1.62, -1.85), (0.9, -1.62, -1.85), 0.035, STEEL)
    _tube(mb, (-1.5, -1.62, -1.45), (0.9, -1.62, -1.45), 0.035, STEEL)
    for x in (-1.5, -0.3, 0.9):
        _tube(mb, (x, -1.32, -1.85), (x, -1.62, -1.85), 0.035, STEEL)
        _tube(mb, (x, -1.62, -1.85), (x, -1.62, -1.45), 0.035, STEEL)
    for k, c in enumerate((SKI1, SKI2, YEL, SKI1)):
        v, f = box(2.3, 0.05, 0.09, (-0.3, -1.38 - k * 0.06, -1.74 + k * 0.05))
        mb.add(v, f, c)
    # ---- Kleinteile: Landescheinwerfer, Antennen, Stufen, Spiegel
    v, f, _ = lathe([(-0.06, 0.13), (0.03, 0.12)], seg=10)
    mb.add(v, f, srgb('#fff6c8'), smooth=True, M=Matrix.Translation((2.5, 0, -2.08)) @ Matrix.Rotation(math.radians(90), 4, 'Y'))
    _tube(mb, (-0.8, 0, -0.05), (-1.2, 0, 0.35), 0.02, BLACK, seg=5)
    _tube(mb, (0.3, 0, -2.3), (0.3, 0, -2.6), 0.015, BLACK, seg=5)
    for s in (-1, 1):
        v, f = box(0.5, 0.18, 0.04, (0.0, s * 1.22, -2.2))
        mb.add(v, f, STEEL)
    ob = mb.build("Heli")

    # ---- Hauptrotor: drei Blätter mit leichter Durchbiegung, Nabe mit Taumelscheibe
    mb = MB()
    for k in range(3):
        a = k * 2 * math.pi / 3
        R = Matrix.Rotation(a, 4, 'Z')
        for (x0, x1, dz) in ((0.4, 2.8, 0.0), (2.8, 5.2, -0.06)):
            v, f = box(x1 - x0, 0.34, 0.045, ((x0 + x1) / 2, 0, dz))
            mb.add(v, f, DARK, M=R)
        v, f = box(0.25, 0.345, 0.05, (5.05, 0, -0.06))
        mb.add(v, f, YEL, M=R)         # gelbe Blattspitzen
    v, f, _ = lathe([(-0.25, 0.32), (-0.1, 0.34), (0.1, 0.22), (0.22, 0.08)], seg=14)
    mb.add(v, f, STEEL, smooth=True)
    mb.build("HeliRotor")
    # ---- Heckrotor (dreht um Y)
    mb = MB()
    for a in (0, 90):
        v, f = box(0.1, 0.05, 1.45, (0, 0, 0))
        mb.add(v, f, DARK, M=Matrix.Rotation(math.radians(a), 4, 'Y'))
    v, f, _ = lathe([(-0.06, 0.09), (0.08, 0.07)], seg=10)
    mb.add(v, f, STEEL, smooth=True, M=Matrix.Rotation(math.radians(90), 4, 'X'))
    mb.build("HeliTail")
    return ["Heli", "HeliRotor", "HeliTail"]
