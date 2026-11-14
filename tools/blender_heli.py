# Helikopter für den Heli-Berg: Rumpf mit Kanzel, Heckausleger, Kufen; Haupt- und Heckrotor als eigene Objekte (drehen im Spiel).
# Aufruf in Blender: exec(blender_build.py); exec(blender_heli.py); make_heli(); danach export().
# Achsen: X = Längsachse (vorne +X), Z = oben. Ursprung = Rotormast-Fuß.
import bpy, math
from mathutils import Matrix


def make_heli():
    for n in ("Heli", "HeliRotor", "HeliTail"):
        ob = bpy.data.objects.get(n)
        if ob:
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
    RED, RED2, WHITE, DARK, GLASS, STEEL = srgb('#d8321e'), srgb('#a8220f'), srgb('#f2f4f7'), srgb('#23272e'), srgb('#1d3550'), srgb('#9aa3ad')
    roty = lambda a: Matrix.Rotation(a, 4, 'Y')
    mb = MB()
    # Rumpf: liegender Rotationskörper entlang X
    rings = [(-2.2, 0.35), (-1.8, 0.85), (-0.9, 1.15), (0.2, 1.2), (1.2, 1.1), (2.0, 0.85), (2.6, 0.45), (2.85, 0.05)]
    cols = [RED2, RED, RED, RED, RED, RED, RED, RED]
    v, f, c = lathe(rings, seg=16, cols=cols)
    mb.add(v, f, c, smooth=True, M=Matrix.Translation((0, 0, -1.25)) @ roty(math.radians(90)) @ Matrix.Diagonal((1, 0.92, 1, 1)))
    # weißer Streifen
    v, f, c = lathe([(-0.6, 1.17), (-0.3, 1.19)], seg=16, cols=[WHITE, WHITE], cap_bot=False, cap_top=False)
    mb.add(v, f, c, smooth=True, M=Matrix.Translation((0, 0, -1.25)) @ roty(math.radians(90)) @ Matrix.Diagonal((1, 0.93, 1.01, 1)))
    # Kanzel (Glas vorne oben)
    v, f, c = lathe([(0.5, 0.0), (0.9, 0.85), (1.6, 1.05), (2.25, 0.92), (2.75, 0.5), (2.95, 0.05)], seg=16, cols=[GLASS] * 6)
    mb.add(v, f, c, smooth=True, M=Matrix.Translation((0.05, 0, -1.0)) @ roty(math.radians(90)) @ Matrix.Diagonal((1, 0.98, 1.08, 1)))
    # Heckausleger und Leitwerk
    v, f, c = lathe([(-1.9, 0.38), (-4.2, 0.22), (-6.4, 0.14)], seg=10, cols=[RED, RED, RED2])
    mb.add(v, f, c, smooth=True, M=Matrix.Translation((0, 0, -0.95)) @ roty(math.radians(90)))
    v, f = box(0.9, 0.08, 1.3, (-6.2, 0, -0.45))
    mb.add(v, f, RED2)
    v, f = box(1.0, 1.4, 0.07, (-5.6, 0, -0.95))
    mb.add(v, f, RED2)
    # Triebwerksverkleidung und Mast
    v, f = box(2.2, 1.1, 0.55, (-0.4, 0, -0.1))
    mb.add(v, f, WHITE)
    v, f, _ = lathe([(-0.2, 0.14), (0.35, 0.12)], seg=8)
    mb.add(v, f, DARK, smooth=True)
    # Kufen
    for y in (-1.05, 1.05):
        v, f = box(4.2, 0.1, 0.1, (0.2, y, -2.75))
        mb.add(v, f, STEEL)
        for x in (-0.9, 1.3):
            v, f = box(0.08, 0.08, 0.75, (x, y * 0.85, -2.4))
            mb.add(v, f, STEEL, M=Matrix.Translation((0, 0, 0)))
    # offene Tür (dunkle Öffnung) auf der rechten Seite
    v, f = box(1.2, 0.05, 1.1, (0.4, -1.08, -1.35))
    mb.add(v, f, DARK)
    mb.build("Heli")
    # Hauptrotor (dreht um Z)
    mb = MB()
    for a in (0, 90, 180, 270):
        v, f = box(5.4, 0.32, 0.05, (2.7, 0, 0))
        mb.add(v, f, DARK, M=Matrix.Rotation(math.radians(a), 4, 'Z'))
    v, f, _ = lathe([(-0.1, 0.25), (0.15, 0.2)], seg=10)
    mb.add(v, f, STEEL, smooth=True)
    mb.build("HeliRotor")
    # Heckrotor (dreht um Y)
    mb = MB()
    for a in (0, 90):
        v, f = box(0.08, 0.05, 1.3, (0, 0, 0))
        mb.add(v, f, DARK, M=Matrix.Rotation(math.radians(a), 4, 'Y'))
    mb.build("HeliTail")
    return ["Heli", "HeliRotor", "HeliTail"]
