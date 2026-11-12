# Zusätzliche Pisten-Elemente (nach blender_build.py und blender_skier.py ausführen, vor export()).
# Inspiriert von Ski-Spielen und echten Skigebieten: Wegweiser, Trail-Tor, Schneekanonen, Zäune, Strohballen,
# Rails/Boxen im Park, Wimpelgirlanden, Totholz, Büsche, Eis. Ursprung = Bodenpunkt, Z nach oben.
# Weiße Flächen (Schilder, Wimpel) werden im Spiel per Instanzfarbe eingefärbt.
# Benötigt die Hilfsfunktionen aus blender_build.py (MB, lathe, box, sphere_rings, extrude_xz, srgb, shade, bevel).
import math, random
import bpy
from mathutils import Matrix


def make_props():
    STEEL, DARK, WOOD, WOOD2 = srgb('#9aa6b2'), srgb('#262a31'), srgb('#8a5a33'), srgb('#5e3b22')
    ORANGE, WHITE, RED, BLUE, YEL = srgb('#ff6a13'), srgb('#f6f8fb'), srgb('#d92d2d'), srgb('#1f6fe5'), srgb('#f2c230')
    SNOW = srgb('#f7faff')
    rnd = random.Random(5)

    def rotz(a):
        return Matrix.Rotation(a, 4, 'Z')

    # ---------------------------------------------------------- Wegweiser (Pfeil nach rechts, weiß = einfärbbar)
    mb = MB()
    v, f, _ = lathe([(-0.3, 0.055), (2.75, 0.05)], seg=8)
    mb.add(v, f, DARK, smooth=True)
    pts = [(-0.85, 2.15), (0.5, 2.15), (0.5, 2.38), (1.0, 1.95), (0.5, 1.52), (0.5, 1.75), (-0.85, 1.75)]
    v, f = extrude_xz(pts, -0.02, 0.02)
    mb.add(v, f, WHITE)
    pts2 = [(-0.93, 2.22), (0.5, 2.22), (0.5, 2.46), (1.1, 1.95), (0.5, 1.44), (0.5, 1.68), (-0.93, 1.68)]
    v, f = extrude_xz(pts2, -0.035, -0.015)
    mb.add(v, f, DARK)
    v, f = box(0.9, 0.03, 0.42, (-0.1, 0.0, 2.62))
    mb.add(v, f, YEL)
    v, f = box(0.32, 0.12, 0.2, (0.0, 0.0, -0.05))
    mb.add(v, f, SNOW)
    mb.build("SignArrow")

    # ---------------------------------------------------------- Trail-Tor (Holzbogen mit Schild)
    mb = MB()
    for x in (-3.3, 3.3):
        v, f, _ = lathe([(-0.4, 0.17), (4.2, 0.15)], seg=8)
        mb.add(v, f, WOOD2, smooth=True, M=Matrix.Translation((x, 0, 0)))
        v, f = box(0.5, 0.5, 0.35, (x, 0, 0.0))
        mb.add(v, f, srgb('#8d8f92'))
    v, f = box(7.4, 0.32, 0.3, (0, 0, 4.2))
    mb.add(v, f, WOOD)
    v, f = box(7.6, 0.55, 0.16, (0, 0, 4.43))
    mb.add(v, f, SNOW)
    for x in (-1.2, 1.2):
        v, f = box(0.03, 0.03, 0.7, (x, 0.0, 3.8))
        mb.add(v, f, DARK)
    v, f = box(3.3, 0.1, 0.95, (0, -0.05, 3.2))
    mb.add(v, f, WOOD2)
    v, f = box(3.1, 0.12, 0.78, (0, -0.06, 3.2))
    mb.add(v, f, WHITE)
    for x in (-1.0, -0.3, 0.4, 1.1):
        v, f = box(0.42, 0.13, 0.09, (x, -0.07, 3.2))
        mb.add(v, f, DARK)
    mb.build("TrailArch")

    # ---------------------------------------------------------- Schneekanone
    mb = MB()
    v, f = box(1.0, 1.0, 0.25, (0, 0, 0.12))
    mb.add(v, f, DARK)
    v, f, _ = lathe([(0.2, 0.3), (0.6, 0.24), (2.8, 0.12)], seg=10)
    mb.add(v, f, STEEL, smooth=True)
    M = Matrix.Translation((0, 0, 2.8)) @ Matrix.Rotation(math.radians(-58), 4, 'X')
    v, f, c = lathe([(-0.3, 0.22), (0.1, 0.34), (1.15, 0.3), (1.5, 0.26)], seg=12, cols=[DARK, RED, RED, WHITE])
    mb.add(v, f, c, smooth=True, M=M)
    v, f, _ = lathe([(1.5, 0.27), (1.56, 0.27)], seg=12)
    mb.add(v, f, DARK, M=M)
    for a in (0, 2.1, 4.2):
        v, f = box(0.08, 1.4, 0.08, (0, 0, 0.0))
        mb.add(v, f, STEEL, M=Matrix.Translation((0, 0, 0.12)) @ rotz(a) @ Matrix.Translation((0, 0.6, 0.6)) @ Matrix.Rotation(math.radians(-35), 4, 'X'))
    mb.build("SnowCannon")

    # ---------------------------------------------------------- Schneezaun (4 m Feld)
    mb = MB()
    for x in (-2.0, 0.0, 2.0):
        v, f, _ = lathe([(-0.3, 0.045), (1.5, 0.04)], seg=6)
        mb.add(v, f, WOOD2, smooth=True, M=Matrix.Translation((x, 0, 0)))
    v, f = box(4.0, 0.03, 1.1, (0, 0, 0.95))
    mb.add(v, f, ORANGE)
    for i in range(11):
        v, f = box(0.03, 0.04, 1.12, (-1.9 + i * 0.38, 0, 0.95))
        mb.add(v, f, shade(ORANGE, 0.75))
    v, f = box(4.05, 0.06, 0.06, (0, 0, 1.52))
    mb.add(v, f, WOOD)
    v, f = box(4.0, 0.12, 0.18, (0, 0, 1.58))
    mb.add(v, f, SNOW)
    mb.build("SnowFence")

    # ---------------------------------------------------------- Umgestürzter Baum
    mb = MB()
    M = Matrix.Translation((0, 0, 0.3)) @ Matrix.Rotation(math.radians(90), 4, 'Y')
    v, f, c = lathe([(-2.4, 0.3), (-2.3, 0.34), (-1.0, 0.31), (1.2, 0.25), (2.3, 0.2), (2.4, 0.18)], seg=10,
                    cols=[srgb('#c9a56b'), WOOD2, WOOD2, WOOD2, WOOD2, srgb('#c9a56b')])
    mb.add(v, f, c, smooth=True, M=M)
    for a, x, h in ((0.5, -0.6, 0.18), (3.9, 0.4, 0.15), (2.2, 1.2, 0.12)):
        Mb = Matrix.Translation((x, 0, 0.45)) @ rotz(a) @ Matrix.Rotation(math.radians(70), 4, 'Y')
        v, f, _ = lathe([(0, 0.08), (0.5, 0.05), (0.9, 0.02)], seg=6)
        mb.add(v, f, WOOD2, smooth=True, M=Mb)
    v, f = box(4.6, 0.3, 0.1, (0, 0, 0.63))
    mb.add(v, f, SNOW, M=Matrix.Translation((0, 0, 0)))
    mb.build("Log")

    # ---------------------------------------------------------- Toter Baum
    mb = MB()
    GREY = srgb('#6e655c')
    v, f, _ = lathe([(-0.3, 0.26), (0.2, 0.22), (2.5, 0.12), (4.6, 0.05)], seg=8)
    mb.add(v, f, GREY, smooth=True)
    for i in range(7):
        a = i * 2.4 + rnd.random()
        h = 1.4 + i * 0.45
        Mb = Matrix.Translation((0, 0, h)) @ rotz(a) @ Matrix.Rotation(math.radians(48 + rnd.random() * 20), 4, 'Y')
        ln = 1.3 - i * 0.1
        v, f, _ = lathe([(0, 0.06), (ln * 0.5, 0.04), (ln, 0.012)], seg=6)
        mb.add(v, f, GREY, smooth=True, M=Mb)
        v, f = box(0.3, 0.08, 0.06, (0, 0, 0))
        mb.add(v, f, SNOW, M=Mb @ Matrix.Translation((ln * 0.35, 0, 0.07)))
    mb.build("DeadTree")

    # ---------------------------------------------------------- Busch
    mb = MB()
    G1, G2 = srgb('#2f4a3a'), srgb('#3b5a43')
    for (x, y, r, z, c) in ((0, 0, 0.7, 0.55, G1), (0.55, 0.2, 0.5, 0.42, G2), (-0.5, -0.2, 0.52, 0.45, G2), (0.1, -0.5, 0.42, 0.36, G1)):
        v, f, _ = lathe(sphere_rings(z, r, r, r * 0.85, n=6, ox=x, oy=y), seg=8)
        mb.add(v, f, c, smooth=True)
        v, f, _ = lathe(sphere_rings(z + r * 0.55, r * 0.7, r * 0.7, r * 0.34, n=5, ox=x, oy=y), seg=8)
        mb.add(v, f, SNOW, smooth=True)
    mb.build("Bush")

    # ---------------------------------------------------------- Strohballen (Aufprallschutz)
    mb = MB()
    HAY = srgb('#d9b24a')
    for (x, z) in ((-0.65, 0.3), (0.65, 0.3), (0.0, 0.9)):
        v, f = box(1.2, 0.9, 0.6, (x, 0, z))
        mb.add(v, f, HAY)
        for dy in (-0.25, 0.25):
            v, f = box(1.22, 0.03, 0.62, (x, dy, z))
            mb.add(v, f, srgb('#7a6a3a'))
    v, f = box(2.6, 0.95, 0.12, (0, 0, 1.25))
    mb.add(v, f, SNOW)
    ob = mb.build("HayBales")
    bevel(ob, 0.04, 1)

    # ---------------------------------------------------------- Rail (Park)
    mb = MB()
    for x in (-3.0, 0.0, 3.0):
        v, f = box(0.14, 0.14, 0.62, (x, 0, 0.31))
        mb.add(v, f, DARK)
    M = Matrix.Translation((0, 0, 0.66)) @ Matrix.Rotation(math.radians(90), 4, 'Y')
    v, f, _ = lathe([(-3.5, 0.05), (3.5, 0.05)], seg=10)
    mb.add(v, f, STEEL, smooth=True, M=M)
    for x in (-3.5, 3.5):
        v, f = box(0.14, 0.26, 0.14, (x, 0, 0.66))
        mb.add(v, f, ORANGE)
    mb.build("Rail")

    # ---------------------------------------------------------- Box (Park)
    mb = MB()
    v, f = box(4.6, 0.85, 0.5, (0, 0, 0.25))
    mb.add(v, f, srgb('#2c3340'))
    v, f = box(4.62, 0.87, 0.07, (0, 0, 0.5))
    mb.add(v, f, srgb('#f2f4f8'))
    for x in (-1.6, 0.0, 1.6):
        v, f = box(0.7, 0.88, 0.5, (x, 0, 0.25))
        mb.add(v, f, BLUE if x == 0 else ORANGE)
    ob = mb.build("ParkBox")
    bevel(ob, 0.03, 1)

    # ---------------------------------------------------------- Wimpelgirlande
    mb = MB()
    for x in (-5.2, 5.2):
        v, f, _ = lathe([(-0.3, 0.06), (3.7, 0.05)], seg=6)
        mb.add(v, f, STEEL, smooth=True, M=Matrix.Translation((x, 0, 0)))
    cols = [RED, WHITE, BLUE, YEL]
    n = 18
    prev = None
    for i in range(n + 1):
        t = i / n
        x = -5.2 + 10.4 * t
        z = 3.6 - 1.0 * 4 * t * (1 - t)
        if prev:
            v, f = box(0.6, 0.015, 0.015, ((x + prev[0]) / 2, 0, (z + prev[1]) / 2))
            mb.add(v, f, DARK, M=Matrix.Translation(((x + prev[0]) / 2, 0, (z + prev[1]) / 2)) @ Matrix.Rotation(math.atan2(z - prev[1], x - prev[0]), 4, 'Y') @ Matrix.Translation((-((x + prev[0]) / 2), 0, -((z + prev[1]) / 2))))
        prev = (x, z)
        if i < n:
            x2 = x + 0.29
            tt = (i + 0.5) / n
            z2 = 3.6 - 1.0 * 4 * tt * (1 - tt)
            v, f = extrude_xz([(x2 - 0.2, z2), (x2 + 0.2, z2), (x2, z2 - 0.5)], -0.01, 0.01)
            mb.add(v, f, cols[i % 4])
    mb.build("Banner")

    # ---------------------------------------------------------- Schneemann
    mb = MB()
    for (z, r) in ((0.5, 0.52), (1.2, 0.39), (1.72, 0.28)):
        v, f, _ = lathe(sphere_rings(z, r, r, r, n=8), seg=12)
        mb.add(v, f, SNOW, smooth=True)
    for x in (-0.09, 0.09):
        v, f, _ = lathe(sphere_rings(1.8, 0.035, 0.035, 0.035, n=4, ox=x, oy=-0.24), seg=6)
        mb.add(v, f, DARK, smooth=True)
    Mn = Matrix.Translation((0, -0.26, 1.72)) @ Matrix.Rotation(math.radians(-90), 4, 'X')
    v, f, _ = lathe([(0, 0.05), (0.32, 0.0)], seg=8)
    mb.add(v, f, ORANGE, smooth=True, M=Mn)
    v, f, _ = lathe([(1.93, 0.2), (2.1, 0.17), (2.12, 0.0)], seg=10)
    mb.add(v, f, DARK, smooth=True)
    v, f, _ = lathe([(1.93, 0.3), (1.95, 0.3)], seg=10)
    mb.add(v, f, DARK)
    for s in (-1, 1):
        Ma = Matrix.Translation((s * 0.35, 0, 1.25)) @ Matrix.Rotation(math.radians(s * 55), 4, 'Y')
        v, f, _ = lathe([(0, 0.025), (0.7, 0.012)], seg=5)
        mb.add(v, f, WOOD2, M=Ma)
    v, f, _ = lathe([(1.35, 0.4), (1.4, 0.2)], seg=10)
    mb.add(v, f, RED, smooth=True, M=Matrix.Translation((0, 0, -0.1)))
    mb.build("Snowman")

    # ---------------------------------------------------------- Eiszapfen / Eissäulen
    mb = MB()
    ICE = [srgb('#cfeeff'), srgb('#a9dcf7'), srgb('#e8f7ff')]
    for i in range(7):
        a = i * 0.9
        r = 0.2 + 0.55 * rnd.random()
        x, y = math.cos(a) * r, math.sin(a) * r
        h = 0.9 + 1.8 * rnd.random()
        w = 0.12 + 0.12 * rnd.random()
        tilt = (rnd.random() - 0.5) * 0.5
        Mi = Matrix.Translation((x, y, 0)) @ rotz(a) @ Matrix.Rotation(tilt, 4, 'Y')
        v, f, c = lathe([(0, w), (h * 0.55, w * 0.6), (h, 0.0)], seg=6, cols=[ICE[i % 3], ICE[(i + 1) % 3], ICE[i % 3]])
        mb.add(v, f, c, smooth=True, M=Mi)
    mb.build("IceCluster")

    # ---------------------------------------------------------- Berghütte (klein)
    mb = MB()
    stone, wood, wood2, dwood = srgb('#8d8f92'), srgb('#8a5630'), srgb('#734523'), srgb('#4a2f1c')
    v, f = box(6.4, 5.0, 0.9, (0, 0, 0.0))
    mb.add(v, f, stone)
    for i in range(5):
        v, f = box(6.1 + (0.1 if i % 2 else 0), 4.7 + (0 if i % 2 else 0.1), 0.4, (0, 0, 0.6 + i * 0.4))
        mb.add(v, f, wood if i % 2 else wood2)
    v, f = extrude_xz([(-3.1, 2.6), (3.1, 2.6), (0, 4.4)], -2.35, 2.35)
    mb.add(v, f, wood2)
    for sx in (-1, 1):
        pts = [(sx * 3.7, 2.35), (0, 4.45), (0, 4.65), (sx * 3.7, 2.55)]
        v, f = extrude_xz(pts, -3.0, 3.0)
        mb.add(v, f, dwood)
        pts = [(sx * 3.85, 2.45), (0, 4.65), (0, 5.0), (sx * 1.5, 4.0), (sx * 3.85, 2.9)]
        v, f = extrude_xz(pts, -3.15, 3.15)
        mb.add(v, f, SNOW)
    v, f = box(0.8, 0.14, 1.7, (0.0, -2.38, 1.3))
    mb.add(v, f, dwood)
    v, f = box(1.0, 0.14, 0.9, (-1.9, -2.38, 1.8))
    mb.add(v, f, srgb('#ffd27a'))
    v, f = box(0.7, 0.7, 1.6, (1.9, 0.8, 4.1))
    mb.add(v, f, stone)
    v, f = box(0.9, 0.9, 0.2, (1.9, 0.8, 4.95))
    mb.add(v, f, SNOW)
    mb.build("MountainHut")


_old_build_all = build_all


def build_all():
    names = _old_build_all()
    make_props()
    return [o.name for o in bpy.data.objects]
