# Bessere Felsen: kantige Granit-Blöcke mit Schnittflächen, Schichtung, Schneeauflage, Flechten und Verschattung am Fuß.
# Aufruf in Blender (ersetzt RockA-RockC und fügt RockD-RockF hinzu), danach export():
#   exec(open(".../tools/blender_build.py").read()); exec(open(".../tools/blender_rocks.py").read()); build_rocks()
import bpy, bmesh, math, random
from mathutils import Vector, noise

ROCK_PAL = [srgb('#5e6169'), srgb('#4a4d55'), srgb('#76746f'), srgb('#6b655d'), srgb('#3f434b'), srgb('#7f8188')]
SNOW_C = srgb('#f4f8ff')
SNOW_BLUE = srgb('#dfe9f8')
LICHEN = [srgb('#8f8d5c'), srgb('#7c8a62'), srgb('#a0805a')]


def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def rock_body(rnd, size, cuts, round_=0.0, strata=0.0, tilt=0.0, offset=(0, 0, 0), sub=4):
    """Liefert (verts, faces, facecols) eines kantigen Felsens. size = Halbachsen (x, y, z)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    off = Vector((rnd.random() * 40, rnd.random() * 40, rnd.random() * 40))
    off2 = Vector((rnd.random() * 40, rnd.random() * 40, rnd.random() * 40))
    sx, sy, sz = size
    meanr = (sx + sy + sz) / 3.0
    # Schnittebenen: Normalen eher nach oben und zur Seite, damit flache Kopfflächen für den Schnee entstehen
    planes = []
    for i in range(cuts):
        a = rnd.random() * 6.2832
        z = rnd.uniform(-0.25, 0.95)
        r = math.sqrt(max(0.0, 1 - z * z))
        n = Vector((math.cos(a) * r, math.sin(a) * r, z)).normalized()
        c = rnd.uniform(0.52, 0.82) * meanr * (1.0 + 0.2 * (1 - abs(z)))
        planes.append((n, c))
    if tilt:
        planes.append((Vector((0.0, -math.sin(tilt), math.cos(tilt))), 0.78 * sz))   # schräge Kopffläche
    for v in bm.verts:
        d = v.co.normalized()
        n1 = noise.noise(d * 1.15 + off) * 0.34 + noise.noise(d * 2.9 + off) * 0.14
        rr = 1 + n1 * (1 - 0.55 * round_)
        p = Vector((d.x * sx * rr, d.y * sy * rr, d.z * sz * rr))
        if round_ < 0.99:
            for n, c in planes:
                s = p.dot(n) - c * (1 + 0.6 * round_)
                if s > 0:
                    p = p - n * s
        # Bruchkanten: leichtes Rauschen entlang der Radialen und horizontale Schichten
        p += d * 0.012 * meanr * noise.noise(p * (2.2 / max(meanr, 0.5)) + off2)
        if strata:
            p.z += strata * math.sin(p.z * 9.0 / max(sz, 0.5) + noise.noise(p * 0.7 + off) * 2.0) * 0.5
        p.z = max(p.z, -0.28 * sz)
        v.co = p
    bm.normal_update()
    verts = [(v.co.x + offset[0], v.co.y + offset[1], v.co.z + offset[2]) for v in bm.verts]
    idx = {v: i for i, v in enumerate(bm.verts)}
    base = ROCK_PAL[rnd.randrange(len(ROCK_PAL))]
    faces, cols = [], []
    for f in bm.faces:
        faces.append([idx[v] for v in f.verts])
        c = f.calc_center_median()
        n = f.normal
        # Grundfarbe: zusammenhängende Flecken (Rauschen) statt Zufall pro Dreieck; Steilwände kühler, dunkler und gestreift
        cn = noise.noise(c * (1.3 / max(meanr, 0.5)) + off2)
        col = mixc(base, ROCK_PAL[(int((cn + 1) * 3.0)) % len(ROCK_PAL)], 0.5 * sstep(-0.2, 0.5, cn))
        col = shade(col, 0.9 + 0.22 * noise.noise(c * (3.0 / max(meanr, 0.5)) + off))
        streak = noise.noise(Vector((c.x * 2.6, c.y * 2.6, c.z * 0.55)) + off2)
        if abs(n.z) < 0.5:
            col = shade(col, 0.8 - 0.16 * max(0.0, streak))
        # Flechten an geschützten Flanken (selten)
        li = noise.noise(c * (2.0 / max(meanr, 0.5)) + off)
        if li > 0.36 and -0.15 < n.z < 0.65:
            col = mixc(col, LICHEN[int(abs(cn) * 10) % len(LICHEN)], 0.5 * sstep(0.36, 0.6, li))
        # Schneeauflage: nur auf wirklich flachen Flächen, Rand unregelmäßig
        cover = sstep(0.52, 0.86, n.z + 0.22 * noise.noise(c * (2.6 / max(meanr, 0.5)) + off2))
        if c.z < -0.05 * sz:
            cover *= 0.4
        col = mixc(col, mixc(SNOW_C, SNOW_BLUE, 0.3 * (1 - n.z)), cover)
        # Verschattung am Fuß und in Spalten
        ao = 0.72 + 0.28 * sstep(-0.28 * sz, 0.7 * sz, c.z)
        cols.append(shade(col, ao))
    bm.free()
    return verts, faces, cols


def make_rock2(name, seed, size, cuts=7, round_=0.0, strata=0.0, tilt=0.0, sub=4, extra=()):
    rnd = random.Random(seed)
    mb = MB()
    v, f, c = rock_body(rnd, size, cuts, round_, strata, tilt, sub=sub)
    mb.add(v, f, None, facecols=c)
    for (sz2, off) in extra:   # Gruppe: kleinere Blöcke daneben
        v, f, c = rock_body(rnd, sz2, max(4, cuts - 2), round_, strata, 0.0, offset=off, sub=max(2, sub - 1))
        mb.add(v, f, None, facecols=c)
    ob = mb.build(name)
    # Auf ca. 40 % der Dreiecke reduzieren: große Flächen bleiben, Kleinkram verschwindet (spart Leistung bei vielen Felsen)
    mod = ob.modifiers.new("Dec", 'DECIMATE')
    mod.ratio = DEC_RATIO
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Dec")
    ob.select_set(False)
    return ob


DEC_RATIO = 0.38


def build_rocks():
    for n in ("RockA", "RockB", "RockC", "RockD", "RockE", "RockF"):
        ob = bpy.data.objects.get(n)
        if ob:
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
    make_rock2("RockA", 5, (1.5, 1.2, 1.05), cuts=8)
    make_rock2("RockB", 9, (2.3, 1.6, 1.4), cuts=9, strata=0.05)
    make_rock2("RockC", 14, (1.05, 1.1, 0.8), cuts=7)
    make_rock2("RockD", 21, (0.8, 1.0, 2.1), cuts=10, strata=0.08, tilt=0.35)          # hohe Felsplatte
    make_rock2("RockE", 33, (1.5, 1.4, 1.0), cuts=3, round_=0.75)                      # abgerundeter Findling
    make_rock2("RockF", 41, (1.4, 1.1, 1.0), cuts=8, extra=(((0.8, 0.7, 0.6), (1.7, 0.6, 0.0)), ((0.6, 0.55, 0.5), (-1.3, -0.9, 0.0))))   # Blockgruppe
    return [o.name for o in bpy.data.objects if o.name.startswith('Rock')]
