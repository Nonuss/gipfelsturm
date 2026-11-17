# Bergdorf für den Freeride-Berg und die Park-Hütte für den Freestyle-Berg.
# Vorbild: Tiroler und Salzburger Bergdörfer (gemauertes Erdgeschoss, Blockbau-Obergeschoss, umlaufender Balkon,
# flaches Satteldach mit weitem Überstand und dicker Schneelast, grüne Fensterläden), Kapelle mit Zwiebelturm,
# Heustadel aus verwittertem Holz.
# Achsen wie in den anderen Skripten: Z oben, Ursprung = Bodenpunkt. Die Schauseite (Giebel mit Balkon) zeigt nach +Y;
# im Spiel (Y-oben-Export) ist das -Z, also talwärts.
# Aufruf headless:
#   Blender tools/models.blend --background --python tools/blender_village.py
# (lädt blender_build.py und blender_skier.py für die Hilfsfunktionen und export(), baut die Modelle neu, exportiert
#  public/models/models.glb und speichert models.blend)
import bpy, math, os, random
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.path.join(os.getcwd(), 'tools')
for fn in ('blender_build.py', 'blender_skier.py'):
    exec(open(os.path.join(HERE, fn)).read(), globals())

WHITE = srgb('#ece7dc'); PLASTER2 = srgb('#e2dccf'); STONE = srgb('#8e8c88'); STONE2 = srgb('#74726e')
LOG = srgb('#6e4527'); LOG2 = srgb('#5b381f'); DARK = srgb('#3a2616'); ROOFW = srgb('#3e2b1d')
SNOW = srgb('#f4f8ff'); SNOWSH = srgb('#dfe8f6'); GLASS = srgb('#ffc874'); GLASS2 = srgb('#ffdca0')
GREEN = srgb('#2f5b3c'); RED = srgb('#8c2b22'); FRAME = srgb('#f2efe8'); COPPER = srgb('#4b8a72'); GOLD = srgb('#d9a838')
GREYW = srgb('#7d6a55'); GREYW2 = srgb('#6a5845')


def rotz(a):
    return Matrix.Rotation(a, 4, 'Z')


def gable_roof(mb, hw, dy, z_eave, rise, ov_x, ov_y, th=0.22, snow=0.38, wood=ROOFW, along='y'):
    """Satteldach. along='y': First entlang Y (Giebel vorne/hinten). Schnee als dicke, gerundete Schicht."""
    for sx in (-1, 1):
        pts = [(sx * (hw + ov_x), z_eave - ov_x * rise / hw), (0, z_eave + rise), (0, z_eave + rise + th), (sx * (hw + ov_x), z_eave - ov_x * rise / hw + th)]
        v, f = extrude_xz(pts, -dy - ov_y, dy + ov_y)
        M = None if along == 'y' else rotz(math.pi / 2)
        mb.add(v, f, wood, M=M)
        # Schneedecke: oben dicker, an der Traufe gerundeter Wulst
        zt = z_eave - ov_x * rise / hw + th
        pts = [(sx * (hw + ov_x + 0.08), zt - 0.05), (0, z_eave + rise + th), (0, z_eave + rise + th + snow),
               (sx * (hw * 0.55), z_eave + rise * 0.45 + th + snow * 1.05), (sx * (hw + ov_x - 0.1), zt + snow * 0.85), (sx * (hw + ov_x + 0.12), zt + snow * 0.35)]
        v, f = extrude_xz(pts, -dy - ov_y - 0.05, dy + ov_y + 0.05)
        mb.add(v, f, SNOW, M=M)


def window(mb, x, y, z, w, h, facing, shutters=GREEN, M0=None):
    """Fenster in einer Wand. facing: +1/-1 = Wand in Y-Richtung (Normale ±Y), +2/-2 = Wand in X-Richtung."""
    def put(v, f, c):
        mb.add(v, f, c, M=M0)
    if abs(facing) == 1:
        s = 1 if facing > 0 else -1
        v, f = box(w + 0.16, 0.08, h + 0.16, (x, y + s * 0.03, z)); put(v, f, FRAME)
        v, f = box(w, 0.1, h, (x, y + s * 0.05, z)); put(v, f, GLASS)
        v, f = box(0.06, 0.12, h, (x, y + s * 0.06, z)); put(v, f, FRAME)
        v, f = box(w, 0.12, 0.06, (x, y + s * 0.06, z + h * 0.1)); put(v, f, FRAME)
        if shutters:
            for k in (-1, 1):
                v, f = box(w * 0.55, 0.06, h + 0.1, (x + k * (w / 2 + w * 0.3), y + s * 0.05, z)); put(v, f, shutters)
                v, f = box(w * 0.5, 0.075, 0.035, (x + k * (w / 2 + w * 0.3), y + s * 0.06, z)); put(v, f, shade(shutters, 0.7))
        v, f = box(w + 0.3, 0.22, 0.08, (x, y + s * 0.12, z - h / 2 - 0.1)); put(v, f, SNOW)
    else:
        s = 1 if facing > 0 else -1
        v, f = box(0.08, w + 0.16, h + 0.16, (x + s * 0.03, y, z)); put(v, f, FRAME)
        v, f = box(0.1, w, h, (x + s * 0.05, y, z)); put(v, f, GLASS)
        v, f = box(0.12, 0.06, h, (x + s * 0.06, y, z)); put(v, f, FRAME)
        if shutters:
            for k in (-1, 1):
                v, f = box(0.06, w * 0.55, h + 0.1, (x + s * 0.05, y + k * (w / 2 + w * 0.3), z)); put(v, f, shutters)
        v, f = box(0.22, w + 0.3, 0.08, (x + s * 0.12, y, z - h / 2 - 0.1)); put(v, f, SNOW)


def log_walls(mb, hw, hd, z0, z1, c1=LOG, c2=LOG2, step=0.32):
    """Blockbau: übereinanderliegende Balken, an den Ecken überstehende Balkenköpfe."""
    n = max(1, int(round((z1 - z0) / step)))
    for i in range(n):
        z = z0 + (i + 0.5) * (z1 - z0) / n
        c = c1 if i % 2 else c2
        hz = (z1 - z0) / n * 0.96
        # Wand bündig (Fenster bleiben frei), nur die Balkenköpfe an den Ecken stehen über
        v, f = box(2 * hw, 2 * hd, hz, (0, 0, z))
        mb.add(v, f, c)
        for sx in (-1, 1):
            for sy in (-1, 1):
                if i % 2:
                    v, f = box(0.34, 0.26, hz, (sx * (hw + 0.1), sy * (hd - 0.13), z))
                else:
                    v, f = box(0.26, 0.34, hz, (sx * (hw - 0.13), sy * (hd + 0.1), z))
                mb.add(v, f, c)


def balcony(mb, x0, x1, y, z, depth=1.05):
    v, f = box(x1 - x0, depth, 0.14, ((x0 + x1) / 2, y + depth / 2, z)); mb.add(v, f, DARK)
    for k in range(int((x1 - x0) / 0.95) + 1):
        v, f = box(0.14, 0.14, 0.32, (x0 + k * 0.95, y + depth - 0.05, z - 0.2)); mb.add(v, f, DARK)
    # Brüstung aus ausgesägten Brettern (Tiroler Balkon)
    nb = int((x1 - x0) / 0.16)
    for k in range(nb):
        xx = x0 + (k + 0.5) * (x1 - x0) / nb
        v, f = box(0.12, 0.05, 0.95, (xx, y + depth - 0.02, z + 0.55)); mb.add(v, f, LOG if k % 2 else LOG2)
    v, f = box(x1 - x0 + 0.1, 0.14, 0.12, ((x0 + x1) / 2, y + depth - 0.02, z + 1.08)); mb.add(v, f, DARK)
    v, f = box(x1 - x0 + 0.14, 0.24, 0.1, ((x0 + x1) / 2, y + depth - 0.02, z + 1.2)); mb.add(v, f, SNOW)
    v, f = box(x1 - x0 - 0.2, 0.12, 0.06, ((x0 + x1) / 2, y + depth * 0.55, z + 0.1)); mb.add(v, f, SNOW)


def chimney(mb, x, y, z0, h):
    v, f = box(0.75, 0.75, h, (x, y, z0 + h / 2)); mb.add(v, f, WHITE)
    v, f = box(0.95, 0.95, 0.14, (x, y, z0 + h)); mb.add(v, f, STONE2)
    v, f = box(0.9, 0.9, 0.22, (x, y, z0 + h + 0.18)); mb.add(v, f, SNOW)


def woodpile(mb, x, y, z, length, along_x=True):
    for row in range(5):
        for k in range(int(length / 0.24)):
            off = (k + 0.5) * 0.24 - length / 2
            px, py = (x + off, y) if along_x else (x, y + off)
            M = Matrix.Translation((px, py, z + 0.13 + row * 0.22)) @ Matrix.Rotation(math.pi / 2, 4, 'X' if along_x else 'Y')
            v, f, _ = lathe([(-0.32, 0.11), (0.32, 0.11)], seg=6)
            mb.add(v, f, srgb('#a9774a') if (k + row) % 3 else srgb('#8f6038'), M=M)
    v, f = box(length + 0.1 if along_x else 0.75, 0.75 if along_x else length + 0.1, 0.12, (x, y, z + 1.25)); mb.add(v, f, SNOW)


# ------------------------------------------------------------------ Bauernhaus groß
def make_house_a():
    mb = MB()
    hw, hd = 4.5, 5.5                      # halbe Breite (X), halbe Tiefe (Y, First)
    v, f = box(2 * hw + 0.3, 2 * hd + 0.3, 1.6, (0, 0, -0.55)); mb.add(v, f, STONE)       # Sockel (reicht in den Hang)
    v, f = box(2 * hw, 2 * hd, 2.75, (0, 0, 0.25 + 1.375)); mb.add(v, f, WHITE)            # gemauertes Erdgeschoss
    v, f = box(2 * hw + 0.06, 2 * hd + 0.06, 0.12, (0, 0, 3.0)); mb.add(v, f, DARK)
    log_walls(mb, hw, hd, 3.06, 5.6)
    gable_roof(mb, hw, hd, 5.6, 2.25, 1.25, 1.45)
    # Giebeldreieck (Holzschalung) vorne und hinten
    for sy in (-1, 1):
        v, f = extrude_xz([(-hw, 5.6), (hw, 5.6), (0, 7.85)], sy * hd - 0.06, sy * hd + 0.06); mb.add(v, f, LOG2)
        for k in range(-4, 5):
            v, f = box(0.06, 0.1, 2.1 - abs(k) * 0.45, (k * 0.95, sy * (hd + 0.05), 5.6 + (2.1 - abs(k) * 0.45) / 2)); mb.add(v, f, DARK)
    # Schauseite +Y: Balkon im Obergeschoss, kleiner Giebelbalkon, Fenster, Tür
    balcony(mb, -hw - 0.3, hw + 0.3, hd, 3.15)
    balcony(mb, -1.6, 1.6, hd, 5.75, depth=0.7)
    for x in (-2.9, -1.0, 1.0, 2.9):
        window(mb, x, hd, 4.75, 0.85, 0.95, 1)
    for x in (-3.0, 3.0):
        window(mb, x, hd, 1.75, 0.95, 1.15, 1)
    v, f = box(1.15, 0.12, 2.15, (0.4, hd + 0.02, 1.33)); mb.add(v, f, DARK)                  # Haustür
    v, f = box(0.8, 0.14, 0.9, (-1.15, hd + 0.02, 1.75)); mb.add(v, f, GLASS2)
    window(mb, 0, hd, 6.55, 0.6, 0.7, 1, shutters=None)
    # Rückseite und Seiten
    for x in (-2.4, 2.4):
        window(mb, x, -hd, 1.75, 0.9, 1.1, -1)
        window(mb, x, -hd, 4.5, 0.8, 1.0, -1)
    for sx in (-1, 1):
        for y in (-3.4, -1.1, 1.2, 3.5):
            window(mb, sx * hw, y, 1.75, 0.9, 1.1, sx * 2)
            window(mb, sx * hw, y, 4.5, 0.8, 1.0, sx * 2)
    chimney(mb, 1.6, -2.2, 6.6, 1.9)
    woodpile(mb, -hw - 0.45, -1.0, 0.0, 4.2, along_x=False)
    # Eiszapfen an der Traufe
    rnd = random.Random(3)
    for sx in (-1, 1):
        for k in range(14):
            y = -hd - 1.2 + k * (2 * hd + 2.4) / 13
            hh = 0.25 + rnd.random() * 0.55
            v, f, _ = lathe([(5.6 - 1.25 * 2.25 / hw - 0.05, 0.05), (5.6 - 1.25 * 2.25 / hw - hh, 0.0)], seg=5)
            mb.add(v, f, srgb('#d8efff'), M=Matrix.Translation((sx * (hw + 1.2), y, 0)))
    mb.build("VillageHouseA")


# ------------------------------------------------------------------ Holzhaus klein
def make_house_b():
    mb = MB()
    hw, hd = 3.4, 4.0
    v, f = box(2 * hw + 0.3, 2 * hd + 0.3, 1.5, (0, 0, -0.5)); mb.add(v, f, STONE2)
    log_walls(mb, hw, hd, 0.25, 3.05, c1=srgb('#7a4b2a'), c2=srgb('#673e22'))
    gable_roof(mb, hw, hd, 3.05, 1.9, 1.0, 1.1)
    for sy in (-1, 1):
        v, f = extrude_xz([(-hw, 3.05), (hw, 3.05), (0, 4.95)], sy * hd - 0.06, sy * hd + 0.06); mb.add(v, f, srgb('#5d3a20'))
    for x in (-1.7, 1.7):
        window(mb, x, hd, 1.65, 0.85, 1.0, 1, shutters=RED)
    window(mb, 0, hd, 3.85, 0.65, 0.75, 1, shutters=RED)
    v, f = box(1.0, 0.12, 2.0, (0, hd + 0.02, 1.25)); mb.add(v, f, DARK)
    v, f = box(2.0, 1.3, 0.12, (0, hd + 0.7, 2.6)); mb.add(v, f, DARK)                       # Vordach über der Tür
    v, f = box(2.1, 1.4, 0.16, (0, hd + 0.7, 2.74)); mb.add(v, f, SNOW)
    for sx in (-1, 1):
        for y in (-1.6, 1.6):
            window(mb, sx * hw, y, 1.65, 0.8, 0.95, sx * 2, shutters=RED)
    window(mb, 0, -hd, 1.65, 0.8, 0.95, -1, shutters=RED)
    chimney(mb, -1.2, 1.4, 3.6, 1.6)
    woodpile(mb, 0, -hd - 0.5, 0.0, 3.0, along_x=True)
    # Bank vor dem Haus
    v, f = box(1.8, 0.4, 0.08, (-2.0, hd + 0.5, 0.48)); mb.add(v, f, LOG)
    for x in (-2.7, -1.3):
        v, f = box(0.1, 0.35, 0.45, (x, hd + 0.5, 0.22)); mb.add(v, f, DARK)
    mb.build("VillageHouseB")


# ------------------------------------------------------------------ Kapelle mit Zwiebelturm
def make_chapel():
    mb = MB()
    hw, hd = 3.0, 4.6
    v, f = box(2 * hw + 0.3, 2 * hd + 0.3, 1.4, (0, 0, -0.45)); mb.add(v, f, STONE)
    v, f = box(2 * hw, 2 * hd, 4.4, (0, 0, 0.25 + 2.2)); mb.add(v, f, WHITE)
    # Ecken und Fensterumrandungen in gebrochenem Weiß/Ocker (Barock)
    for sx in (-1, 1):
        for sy in (-1, 1):
            v, f = box(0.3, 0.3, 4.4, (sx * (hw - 0.1), sy * (hd - 0.1), 2.45)); mb.add(v, f, srgb('#e3c98f'))
    gable_roof(mb, hw, hd, 4.65, 2.6, 0.55, 0.5, wood=srgb('#4a4d52'))
    for sy in (-1, 1):
        v, f = extrude_xz([(-hw, 4.65), (hw, 4.65), (0, 7.25)], sy * hd - 0.05, sy * hd + 0.05); mb.add(v, f, WHITE)
    # Rundbogenfenster an den Seiten
    for sx in (-1, 1):
        for y in (-2.2, 0.0, 2.2):
            v, f = box(0.12, 0.85, 1.7, (sx * (hw + 0.02), y, 2.6)); mb.add(v, f, srgb('#e3c98f'))
            v, f = box(0.14, 0.6, 1.45, (sx * (hw + 0.04), y, 2.55)); mb.add(v, f, srgb('#9fc4e8'))
            v, f, _ = lathe([(0, 0.3), (0.14, 0.3)], seg=10, rot=0)
            mb.add(v, f, srgb('#9fc4e8'), M=Matrix.Translation((sx * (hw + 0.04), y, 3.27)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    # Turm vorne (+Y): quadratischer Schaft, Schallöffnungen, Uhr, Zwiebelhaube mit Laterne und Kreuz
    ty = hd + 1.25                         # Turm steht vor der Fassade, der Eingang führt durch ihn
    v, f = box(2.9, 2.9, 1.2, (0, ty, -0.35)); mb.add(v, f, STONE)
    v, f = box(2.6, 2.6, 8.2, (0, ty, 4.1)); mb.add(v, f, WHITE)
    v, f = box(2.75, 2.75, 0.22, (0, ty, 8.2)); mb.add(v, f, srgb('#e3c98f'))
    for a in range(4):
        M = Matrix.Translation((0, ty, 0)) @ rotz(a * math.pi / 2)
        v, f = box(0.75, 0.1, 1.3, (0, 1.32, 7.2)); mb.add(v, f, srgb('#2a2622'), M=M)
        v, f, _ = lathe([(0, 0.45), (0.06, 0.45)], seg=16)
        mb.add(v, f, FRAME, M=M @ Matrix.Translation((0, 1.33, 5.6)) @ Matrix.Rotation(math.pi / 2, 4, 'X'))
        v, f = box(0.06, 0.04, 0.34, (0, 1.4, 5.66)); mb.add(v, f, DARK, M=M)
        v, f = box(0.24, 0.04, 0.05, (0.1, 1.4, 5.6)); mb.add(v, f, DARK, M=M)
    onion = [(8.3, 1.25), (8.6, 1.35), (9.0, 1.45), (9.4, 1.4), (9.8, 1.15), (10.2, 0.75), (10.55, 0.35), (10.8, 0.2), (11.6, 0.2),
             (11.65, 0.42), (11.95, 0.55), (12.25, 0.42), (12.5, 0.18), (12.8, 0.05)]
    v, f, _ = lathe(onion, seg=16)
    mb.add(v, f, COPPER, smooth=True, M=Matrix.Translation((0, ty, 0)))
    # Schneehaube auf der Zwiebel
    v, f, _ = lathe([(9.32, 1.43), (9.6, 1.36), (9.95, 1.06), (10.2, 0.78), (10.25, 0.6)], seg=16)
    mb.add(v, f, SNOW, smooth=True, M=Matrix.Translation((0, ty, 0.03)))
    v, f = box(0.08, 0.08, 1.1, (0, ty, 13.3)); mb.add(v, f, GOLD)
    v, f = box(0.55, 0.08, 0.08, (0, ty, 13.5)); mb.add(v, f, GOLD)
    v, f, _ = lathe([(12.75, 0.1), (12.95, 0.1)], seg=10)
    mb.add(v, f, GOLD, smooth=True, M=Matrix.Translation((0, ty, 0)))
    # Portal
    v, f = box(1.2, 0.12, 2.2, (0, ty + 1.32, 1.35)); mb.add(v, f, srgb('#5a3820'))
    v, f = box(1.5, 0.14, 0.25, (0, ty + 1.34, 2.55)); mb.add(v, f, srgb('#e3c98f'))
    mb.build("Chapel")


# ------------------------------------------------------------------ Heustadel
def make_hayloft():
    mb = MB()
    hw, hd = 2.6, 3.2
    for sx in (-1, 1):
        for sy in (-1, 1):
            v, f = box(0.5, 0.5, 0.6, (sx * (hw - 0.2), sy * (hd - 0.2), -0.05)); mb.add(v, f, STONE)
    v, f = box(2 * hw, 2 * hd, 0.16, (0, 0, 0.3)); mb.add(v, f, GREYW2)
    rnd = random.Random(7)
    # senkrechte, verwitterte Bretter mit Lücken
    for sy in (-1, 1):
        n = int(2 * hw / 0.24)
        for k in range(n):
            x = -hw + (k + 0.5) * 2 * hw / n
            c = GREYW if rnd.random() < 0.5 else GREYW2
            v, f = box(0.2, 0.06, 2.4, (x, sy * hd, 1.5)); mb.add(v, f, c)
    for sx in (-1, 1):
        n = int(2 * hd / 0.24)
        for k in range(n):
            y = -hd + (k + 0.5) * 2 * hd / n
            c = GREYW if rnd.random() < 0.5 else GREYW2
            v, f = box(0.06, 0.2, 2.4, (sx * hw, y, 1.5)); mb.add(v, f, c)
    v, f = box(2 * hw - 0.1, 2 * hd - 0.1, 2.3, (0, 0, 1.5)); mb.add(v, f, srgb('#3a2d22'))
    gable_roof(mb, hw, hd, 2.7, 1.55, 0.6, 0.6, wood=srgb('#5a4a3a'), snow=0.42)
    for sy in (-1, 1):
        v, f = extrude_xz([(-hw, 2.7), (hw, 2.7), (0, 4.25)], sy * hd - 0.05, sy * hd + 0.05); mb.add(v, f, GREYW2)
    v, f = box(1.3, 0.1, 1.7, (0, hd + 0.03, 1.25)); mb.add(v, f, srgb('#52402f'))
    mb.build("Hayloft")


# ------------------------------------------------------------------ Park-Hütte (Freestyle)
# Maße passen zum Spiel (piste.js, Hüttensprünge): Breite 9 m (X), Tiefe 8 m (Y), Traufe 2,6 m über dem Boden,
# First 4,1 m, First entlang X. Fahrtrichtung ist -Y (Spiel: -Z ist talwärts, Blender -Y wird im Spiel +Z ...)
# Die Dachfläche zur Bergseite liegt unter dem Schnee der Schanze; die talseitige Dachhälfte und die Wände bleiben frei.
def make_park_hut():
    mb = MB()
    hw, hd, E, rise = 4.5, 4.0, 2.6, 1.5
    v, f = box(2 * hw + 0.3, 2 * hd + 0.3, 2.6, (0, 0, -1.05)); mb.add(v, f, STONE)          # Steinsockel bis tief in den Hang
    log_walls(mb, hw, hd, 0.25, E, c1=srgb('#7b4a28'), c2=srgb('#663c20'))
    # Dach: First entlang X, Flächen fallen nach ±Y. Oberkante des Dachs genau auf Traufe + rise (Spielgeometrie)
    for sy in (-1, 1):
        ov = 0.75
        pts = [(sy * (hd + ov), E - ov * rise / hd - 0.2), (0, E + rise - 0.2), (0, E + rise - 0.02), (sy * (hd + ov), E - ov * rise / hd - 0.02)]
        v, f = extrude_xz(pts, -hw - 0.6, hw + 0.6)
        mb.add(v, f, ROOFW, M=rotz(math.pi / 2) if False else Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))))
        pts = [(sy * (hd + ov + 0.05), E - ov * rise / hd - 0.04), (0, E + rise - 0.03), (0, E + rise + 0.1), (sy * (hd + ov - 0.1), E - ov * rise / hd + 0.12), (sy * (hd + ov + 0.1), E - ov * rise / hd + 0.04)]
        v, f = extrude_xz(pts, -hw - 0.65, hw + 0.65)
        mb.add(v, f, SNOW, M=Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))))
    for sx in (-1, 1):
        # Giebeldreiecke an den Seiten (±X)
        pts = [(-hd, E), (hd, E), (0, E + rise - 0.2)]
        v, f = extrude_xz(pts, sx * hw - 0.06, sx * hw + 0.06)
        mb.add(v, f, srgb('#5a361d'), M=Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))))
        window(mb, sx * hw, -1.6, 1.5, 0.8, 0.9, sx * 2)
        window(mb, sx * hw, 1.6, 1.5, 0.8, 0.9, sx * 2)
    # Talseite (+Y im Modell, im Spiel -Z = talwärts): Fenster, Tür, Schild, Bank; die Bergseite liegt im Schnee
    for sy in (-1, 1):
        for x in (-2.6, 2.6):
            window(mb, x, sy * hd, 1.5, 0.95, 1.0, sy)
    v, f = box(1.05, 0.12, 2.0, (0, hd + 0.02, 1.25)); mb.add(v, f, DARK)
    v, f = box(2.6, 0.1, 0.55, (0, hd + 0.06, 2.0)); mb.add(v, f, srgb('#2a3442'))
    v, f = box(2.4, 0.12, 0.4, (0, hd + 0.08, 2.0)); mb.add(v, f, srgb('#ffd23f'))
    v, f = box(2.2, 0.42, 0.08, (-2.6, hd + 0.45, 0.5)); mb.add(v, f, LOG)
    chimney(mb, 2.4, 1.2, 3.0, 1.5)
    mb.build("ParkHut")


NEW = ["VillageHouseA", "VillageHouseB", "Chapel", "Hayloft", "ParkHut"]
for nm in NEW:
    o = bpy.data.objects.get(nm)
    if o:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)
make_house_a(); make_house_b(); make_chapel(); make_hayloft(); make_park_hut()
ROOT = os.path.dirname(HERE)
print('EXPORT', export(os.path.join(ROOT, 'public', 'models', 'models.glb')))
bpy.ops.wm.save_mainfile(filepath=os.path.join(HERE, 'models.blend'))
print('OBJS', len([o for o in bpy.data.objects if o.type == 'MESH']))
