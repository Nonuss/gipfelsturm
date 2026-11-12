# Neuer Pistenzaun: orangefarbenes Fangnetz zwischen dünnen Stangen (statt Holzbrettern), leicht durchhängend, Schneehaufen am Fuß.
# Aufruf in Blender: exec(blender_build.py); exec(blender_fence.py); make_fence_net(); danach export().
import bpy, math, random
from mathutils import Matrix


def make_fence_net():
    ob = bpy.data.objects.get("SnowFence")
    if ob:
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
    rnd = random.Random(77)
    NET = srgb('#ff6a13'); NET2 = srgb('#e8520a'); POLE = srgb('#3a3f48'); WOOD = srgb('#6b4a2b'); SNOW = srgb('#f4f8ff')
    mb = MB()
    # Stangen: leicht schief, unterschiedlich hoch
    for x in (-2.0, 0.0, 2.0):
        h = 1.5 + rnd.uniform(-0.08, 0.1)
        lean = rnd.uniform(-0.05, 0.05)
        v, f, _ = lathe([(-0.35, 0.03), (h, 0.026)], seg=6)
        mb.add(v, f, POLE if rnd.random() < 0.6 else WOOD, smooth=True, M=Matrix.Translation((x, 0, 0)) @ Matrix.Rotation(lean, 4, 'X'))
        # kleine Schneewehe am Fuß
        v, f = box(0.5, 0.4, 0.14, (x, 0, 0.02))
        mb.add(v, f, SNOW)
    # Netz: Waagerechte (viertelweise geknickt, damit es durchhängt) und Senkrechte
    def sag(x):
        return 0.07 * (1 - (x / 2.0) ** 2) if abs(x) < 2 else 0.0
    rows = [0.42, 0.62, 0.82, 1.02, 1.22, 1.38]
    for zi, z0 in enumerate(rows):
        col = NET if zi % 2 == 0 else NET2
        n = 8
        for k in range(n):
            xa = -2.0 + 4.0 * k / n; xb = -2.0 + 4.0 * (k + 1) / n
            za = z0 - sag(xa) * (z0 / 1.4); zb = z0 - sag(xb) * (z0 / 1.4)
            L = math.hypot(xb - xa, zb - za)
            ang = -math.atan2(zb - za, xb - xa)
            v, f = box(L, 0.025, 0.03, (0, 0, 0))
            mb.add(v, f, col, M=Matrix.Translation(((xa + xb) / 2, 0, (za + zb) / 2)) @ Matrix.Rotation(ang, 4, 'Y'))
    for k in range(0, 17):
        x = -1.9 + k * 0.2375
        top = 1.38 - sag(x) * 0.95
        v, f = box(0.022, 0.022, top - 0.4, (x, 0, 0.4 + (top - 0.4) / 2))
        mb.add(v, f, NET2 if k % 2 else NET)
    # Oberkante: Seil
    for k in range(8):
        xa = -2.0 + 0.5 * k; xb = xa + 0.5
        za = 1.46 - sag(xa); zb = 1.46 - sag(xb)
        v, f = box(math.hypot(0.5, zb - za), 0.03, 0.035, (0, 0, 0))
        mb.add(v, f, srgb('#2c3038'), M=Matrix.Translation(((xa + xb) / 2, 0, (za + zb) / 2)) @ Matrix.Rotation(-math.atan2(zb - za, 0.5), 4, 'Y'))
    return mb.build("SnowFence")


def make_trail_arch():
    """Einfahrt zur Waldbahn: zwei Rundholz-Pfosten, Querbalken mit Schneeauflage, hängendes Holzschild mit Tannen-Symbol.
    Ersetzt das alte Trail-Tor (Schild mit Strich-Platzhaltern). Feste Farben, keine Einfärbung im Spiel."""
    ob = bpy.data.objects.get("TrailArch")
    if ob:
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
    LOG, LOG2, END = srgb('#7a5434'), srgb('#5c3d24'), srgb('#c9a56b')
    BOARD, GREEN, SNOW, CHAIN = srgb('#a8784a'), srgb('#1f5a3a'), srgb('#f6f9ff'), srgb('#2b2e34')
    mb = MB()
    for x, lean in ((-3.3, 0.02), (3.3, -0.025)):
        v, f, _ = lathe([(-0.4, 0.19), (0.3, 0.17), (4.3, 0.15), (4.45, 0.12)], seg=10, cols=[LOG2, LOG, LOG, END])
        mb.add(v, f, _, smooth=True, M=Matrix.Translation((x, 0, 0)) @ Matrix.Rotation(lean, 4, 'Y'))
        v, f = box(0.7, 0.6, 0.25, (x, 0, 0.05))
        mb.add(v, f, SNOW)
    # Querbalken als Rundholz
    v, f, c = lathe([(-3.9, 0.15), (-3.75, 0.17), (3.75, 0.16), (3.9, 0.14)], seg=10, cols=[END, LOG, LOG, END])
    mb.add(v, f, c, smooth=True, M=Matrix.Translation((0, 0, 4.15)) @ Matrix.Rotation(math.radians(90), 4, 'Y'))
    # Schneeauflage, leicht unregelmäßig
    for k in range(6):
        x = -3.4 + k * 1.36
        v, f = box(1.45, 0.34, 0.12 + 0.05 * (k % 2), (x, 0, 4.33))
        mb.add(v, f, SNOW)
    # Ketten und Schild
    for x in (-0.95, 0.95):
        v, f = box(0.04, 0.04, 0.5, (x, 0, 3.78))
        mb.add(v, f, CHAIN)
    v, f = box(2.3, 0.1, 0.95, (0, 0, 3.05))
    mb.add(v, f, BOARD)
    for z in (2.75, 3.05, 3.35):   # Bretterfugen
        v, f = box(2.32, 0.11, 0.025, (0, 0, z))
        mb.add(v, f, LOG2)
    # Tannen-Symbol auf beiden Seiten (drei Dreiecke + Stamm)
    for side in (-1, 1):
        y = side * 0.065
        for i, (w, z0) in enumerate(((0.62, 2.7), (0.5, 2.92), (0.36, 3.13))):
            pts = [(-w / 2, z0), (w / 2, z0), (0, z0 + 0.34)]
            v, f = extrude_xz(pts, y - 0.01, y + 0.01)
            mb.add(v, f, GREEN)
        v, f = box(0.1, 0.03, 0.14, (0, y, 2.63))
        mb.add(v, f, LOG2)
        v, f = box(2.3, 0.03, 0.08, (0, y, 3.52))   # Schnee auf dem Schild
        mb.add(v, f, SNOW)
    return mb.build("TrailArch")
