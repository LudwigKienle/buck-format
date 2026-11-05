# `.buck` – Look-Format mit räumlichen Effekten

Status: **Entwurf 0.1, Konzept und Spezifikation** · Stand: 31.10.2026 · Referenz-Prototyp: Web-Engine und Editor unter `src/buck/` (Phase 2 und Teile von Phase 4, dazu die Optik-Knoten §5.3.6–§5.3.8); OFX-Unterstützung (Phase 3) steht noch aus. Umsetzungsstand: §14.

Dieses Dokument beschreibt ein eigenes Austauschformat für Buckswood Auto LUT. Eine `.buck`-Datei enthält einen Farblook. Sie kann außerdem räumliche Effekte enthalten, die eine 3D-LUT grundsätzlich nicht abbilden kann, nämlich atmosphärischen Nebel, Himmel, Tiefenschärfe, Relight und Lampen sowie Objektiv- und Filmeffekte (Vignette, Halation, Filmkorn). Die Datei beschreibt diese Effekte als **deklarativen, parametrischen Knotengraphen**. Sie enthält keinen ausführbaren Code. Jeder Host, der die Spezifikation umsetzt, soll aus derselben Datei und denselben Hilfskanälen innerhalb festgelegter Toleranzen dasselbe Bild erzeugen.

Begriffe: **MUSS**, **SOLL** und **KANN** werden im Sinne von RFC 2119 verwendet. **Host** ist die ausführende Anwendung (Web-Editor, OFX-Plugin in Resolve oder Baselight, spätere Exporter). **Hilfskanal** ist ein nicht farbliches Bildsignal wie Tiefe, Normalen oder Maske.

---

## 1. Ziel und Abgrenzung

### 1.1 Ziel

1. **Ein Look, eine Datei:** Farbe und räumliche Effekte liegen in einer portablen Datei. Diese lässt sich versionieren, archivieren und in mehrere Hosts laden.
2. **Reproduzierbar:** Die Semantik jedes Knotens ist mathematisch festgelegt und durch eine Referenzimplementierung mit Testvektoren abgesichert (§7). Ein „ähnlich aussehendes“ Ergebnis reicht nicht.
3. **Ehrliche Abhängigkeiten:** Effekte, die Tiefe oder Normalen brauchen, deklarieren das. Wenn der Host diese Kanäle nicht liefert, werden sie mit einem Modell geschätzt, dessen Gewichte per Hash festgelegt sind (§6).
4. **Abwärtskompatibel:** Für Hosts ohne `.buck`-Unterstützung kann eine eingebettete `.cube` den reinen Farbanteil transportieren. Sie ist eine deklarierte Degradierung, keine gleichwertige Darstellung (§3.4).
5. **Sicher:** Die Datei enthält weder Skripte noch Shader, Ausdrücke oder Binärcode und lädt nichts aus dem Netz (§11).

### 1.2 Nicht-Ziele (Version 1)

- Kein Compositing-Werkzeug: kein Tracking, Rotoscoping, allgemeines Keying, Partikel und keine 3D-Szenenrekonstruktion. Erlaubt ist der Himmelsersatz `sky.replace@1` (§5.3.4): Seine Maske kommt aus der Tiefe (ungültig oder fern) und wird nur in einem schmalen Kantenband farblich verfeinert. Ein frei wählbarer Farb- oder Luminanz-Key ist das nicht.
- Keine generative KI. Die Pixel des Ausgangsbilds werden nur gefiltert und gemischt, nie neu erfunden. ML wird ausschließlich zur Schätzung von Hilfskanälen eingesetzt. Ein prozeduraler Himmel (§5.3.4) ist eine feste, deterministische Formel (Verlauf, Rauschen auf festem Gitter, Hash-Sterne) und kein gelerntes Modell; ein Himmelsbild muss im Archiv liegen.
- Kein Ersatz für OCIO oder ACES. `.buck` nutzt deren Farbraumbezeichnungen (§8) und definiert keine eigene Farbraumverwaltung.
- Keine frei programmierbaren Knoten. Neue Effekte kommen als neue, versionierte Knotentypen in die Spezifikation.

### 1.3 Vergleich mit bestehenden Formaten

| Format | Was es transportiert | Räumlich? | Ausführbarer Inhalt | Host-Bindung | Bezug zu `.buck` |
|---|---|---|---|---|---|
| **`.cube` / 3D-LUT** | Positionsunabhängige Abbildung RGB→RGB auf einem Gitter | Nein | Nein | Breit unterstützt | Eingebettet als Fallback und optionaler `color.lut3d`-Knoten |
| **CLF / SMPTE ST 2136-1** | XML-Kette von Farboperatoren (Matrix, 1D/3D-LUT, Range, Log, CDL …) | Nein | Nein | OCIO, wachsend | Vorbild für die deklarative Operatorkette; späterer Exportpfad für den Farbanteil |
| **OCIO-Config / Looks** | Farbräume, Displays/Views und Looks mit `process_space` | Nein | Nein (Transformdefinitionen) | Sehr breit in VFX | Liefert Farbraumnamen und Konvertierungen (§8) |
| **ACES AMF** | XML-Sidecar zur Rekonstruktion der ACES-Pipeline (Input, Looks, Output), verweist auf CDL/CLF | Nein | Nein | ACES-Hosts | Metadatenvorbild; AMF beschreibt die Pipeline, nicht die Effekte |
| **ASC CDL** | 10 Zahlen: Slope, Offset, Power je Kanal und Sättigung | Nein | Nein | Sehr breit am Set | Optionaler `color.cdl`-Knoten |
| **DCTL** | C-ähnlicher GPU-Pixelshader für Resolve (auch verschlüsselt als `.dctle`) | Ja, mit Pixelkoordinaten und Texturen | **Ja** | Nur Resolve | Mögliches späteres Exportziel; als Inhalt ausgeschlossen |
| **OFX** | Plugin-ABI für Bildeffekte, kein Dateiformat | Ja | Ja (native Bibliothek) | Resolve, Baselight, Nuke … | Verteilungsweg: das OFX-Plugin liest `.buck` (§12) |
| **Nuke-Gizmo** | Als Datei gespeicherte Group-Node-Struktur (TCL) | Ja | Ja (TCL/Python-Ausdrücke möglich) | Nur Nuke | Strukturelles Vorbild „Graph als Datei“, aber deklarativ statt skriptbar |

Kurz: Die Farbformate (`.cube`, CLF, CDL, OCIO-Looks, AMF) arbeiten pro Pixel und positionsunabhängig. Räumliche Effekte können sie prinzipiell nicht darstellen. Die räumlich mächtigen Wege (DCTL, OFX, Gizmo) sind ausführbarer Code und an einen Host gebunden. `.buck` liegt dazwischen: räumlich, aber deklarativ, und über mehrere Hosts nachrechenbar.

Quellen:

- `.cube`: [OpenColorIO Iridas-Cube-Parser](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/fileformats/FileFormatIridasCube.cpp), [Resolve-Cube-Parser](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/fileformats/FileFormatResolveCube.cpp); siehe auch `docs/RESEARCH_DEEP.md` §1.
- CLF: [CLF-Spezifikation v3 (ACES)](https://docs.acescentral.com/clf/specification/), [SMPTE ST 2136-1:2026 „Common LUT Format — Core Specification“](https://pub.smpte.org/doc/st2136-1/20260226-pub/st2136-1-2026.pdf). Laut ACES-Seite löst der SMPTE-Standard die v3-Spezifikation ab und soll rückwärtskompatibel bleiben.
- OCIO: [Looks (Authoring Guide)](https://opencolorio.readthedocs.io/en/latest/guides/authoring/looks.html), [OCIO 2.6 Release Notes](https://opencolorio.readthedocs.io/en/latest/releases/ocio_2_6.html).
- AMF: [ACES Metadata File Specification](https://docs.acescentral.com/amf/specification/). Laut [Guide](https://draftdocs.acescentral.com/amf/guides/user) werden Looks dort in ACES2065-1 (AP0 linear) angewendet.
- ASC CDL: [Übersicht](https://en.wikipedia.org/wiki/ASC_CDL). Die normative Implementierer-Dokumentation gibt die ASC nur auf Anfrage heraus; sie wurde hier nicht eingesehen.
- DCTL: Lokale Blackmagic-Entwicklerdoku `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/DaVinciCTL/README.txt` (Resolve 21.1 auf diesem Rechner). Sie beschreibt DCTL als „pixel shader“-Programm, die Ausführung als LUT, als DCTL-OFX oder als Transition sowie die Verschlüsselung als `.dctle`.
- OFX: [ASWF OpenFX](https://github.com/AcademySoftwareFoundation/openfx), [Image-Effect-Referenz](https://openfx.readthedocs.io/en/main/Reference/api/file/ofxImageEffect_8h.html); lokal vendorte Header in `native/ofx/third_party/openfx/include/` (u. a. `ofxColour.h` mit OFX-1.5-Farbmanagement).
- Nuke: [Creating and Accessing Gizmos (Foundry)](https://learn.foundry.com/nuke/content/comp_environment/configuring_nuke/creating_sourcing_gizmos.html), [`nuke.Gizmo`-API](https://learn.foundry.com/nuke/developers/13.2/pythondevguide/_autosummary/nuke.Gizmo.html).

### 1.4 Verhältnis zu bestehendem Buckswood-Code

- `src/color/look.ts` (`LookSpec`, `applyLook`) definiert heute die Mathematik des Farblooks. `src/color/prompt.ts` erzeugt daraus lokal und deterministisch Looks aus Text. Der `.buck`-Knoten `color.look@1` übernimmt `LookSpec` unverändert als Parametersatz (§5.2.1). Jede Änderung an `applyLook` MUSS künftig eine neue Knotenversion bekommen.
- `src/recipe.ts` (Schema `buckswood-auto-lut/1`) beschreibt ein Editor-Rezept mit Referenzprofil und bleibt ein eigenes Format. Ein Rezept KANN in `.buck` als Provenienz unter `meta.recipe` liegen. Nötig ist es zum Rendern nicht.
- `native/ofx/` ist heute ein reiner Cube-Lader: CPU, ohne zeitliche Abhängigkeiten und ohne implizite Farbraumkonvertierung. Diese Prinzipien gelten auch für `.buck` (§9, §12).

---

## 2. Gesamtarchitektur

```
                ┌────────────── .buck (Look, shot-unabhängig) ──────────────┐
                │ graph.json  ·  luts/*.cube  ·  thumbs/*  ·  manifest.json │
                └──────────────────────────────┬────────────────────────────┘
                                               │
Host-Bild ──► [Eingangs-CST laut graph] ──► Knotengraph ──► [Ausgangs-CST] ──► Host-Ausgabe
                                               ▲
                Hilfskanäle je Shot ───────────┘
                (1) vom Host geliefert (Clip/AOV)
                (2) aus Analyse-Cache (.buckaux)
                (3) ML-Schätzung mit gepinntem Modell → schreibt (2)
```

Zentrale Trennung: **Look und Shot-Bindung sind zwei Dinge.**

- Die `.buck`-Datei ist shot-unabhängig. Sie beschreibt, *was* mit Tiefe, Normalen und Masken geschehen soll.
- Die Hilfskanäle eines konkreten Shots liegen in einem **Analyse-Cache** (§6.4). Der Host erzeugt ihn einmal in einem Analyse-Durchlauf, der Rendervorgang liest ihn nur. Das hält den Render zustandslos und frame-unabhängig, wie es Baselight verlangt (getrennte Renderinstanzen ohne sequentielles Rendern, siehe `docs/HOST_COMPATIBILITY.md`).
- Bit-genaue Reproduzierbarkeit über Hosts gilt für das Paar *(`.buck`, Hilfskanäle)*. ML-Inferenz selbst ist über Backends nicht bit-genau (§7.3). Wer ein Ergebnis exakt weitergeben will, gibt den Cache mit.

---

## 3. Container

### 3.1 Grundform

Eine `.buck`-Datei ist ein ZIP-Archiv ([PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)) mit diesen Einschränkungen:

- Erlaubte Kompressionsmethoden: nur `0` (stored) und `8` (deflate). Keine Verschlüsselung, kein ZIP64 in Version 1, keine mehrteiligen Archive.
- Der **erste** Eintrag MUSS `mimetype` heißen, unkomprimiert sein und genau den ASCII-Text `application/vnd.buckswood.buck+zip` enthalten, ohne Zeilenumbruch. Dieses Verfahren übernimmt `.buck` von EPUB/ODF ([EPUB 3.3 OCF](https://www.w3.org/TR/epub-33/)). Damit lässt sich die Datei ohne Entpacken erkennen.
- Dateinamen sind UTF-8 (Flag Bit 11) und bestehen nur aus `[a-z0-9._/-]`, mit Kleinbuchstaben und relativen Pfaden. Verboten sind `..`, ein führendes `/`, `\`, Laufwerksbuchstaben, doppelte Namen und symbolische Links.

### 3.2 Inhalt

| Pfad | Pflicht | Inhalt |
|---|---|---|
| `mimetype` | ja | siehe oben |
| `manifest.json` | ja | Dateiliste mit SHA-256, Größe und Medientyp jedes Eintrags außer `mimetype` und `manifest.json` |
| `graph.json` | ja | Knotengraph, Eingaben, Farbmanagement, Metadaten (§4–§6) |
| `luts/*.cube` | nein | Eingebettete 3D-LUTs (Iridas/BMD, reiner 3D-Teil, wie `native/ofx` sie heute liest) |
| `thumbs/before.jpg`, `thumbs/after.jpg` | nein | Vorschaubilder, JPEG oder PNG, sRGB, längste Seite ≤ 1024 px |
| `thumbs/aux-depth.png` | nein | Vorschau eines Hilfskanals (16-Bit-Graustufen-PNG), nur zur Anzeige |
| `masks/*.png` | nein | Statische Formmasken (z. B. eine gezeichnete Form), 8/16-Bit-Graustufen, auflösungsunabhängig skaliert; für eine Randabdunklung gibt es `lens.vignette@1` (§5.3.6) |
| `skies/*.png` | nein | Himmelsbilder für `sky.replace@1` mit `source: "image"` (§5.3.4). PNG mit sRGB-Kodierung, 8/16 Bit, geprüft wie Masken (§11.4). JPEG ist in Version 1 nicht erlaubt, weil der Referenzleser keinen geprüften JPEG-Decoder hat. |
| `meta/recipe.json` | nein | Optionales Buckswood-Rezept als Provenienz |
| `ext/<vendor>/…` | nein | Erweiterungsdaten; ein Reader MUSS sie ignorieren können |

Andere Pfade sind nicht erlaubt. Ein Reader MUSS eine Datei ablehnen, wenn ein Hash aus `manifest.json` nicht stimmt oder ein Eintrag nicht im Manifest steht.

### 3.3 `manifest.json`

```json
{
  "buckManifest": 1,
  "files": [
    {"path": "graph.json", "size": 4211, "sha256": "…", "mediaType": "application/json"},
    {"path": "luts/fargo_look_rec709_64.cube", "size": 9437622, "sha256": "…", "mediaType": "text/plain"}
  ]
}
```

Der Hash von `graph.json` dient zugleich als **Look-ID**. Hosts und Analyse-Caches beziehen sich darauf.

### 3.4 Eingebettete `.cube`

- Ein `color.lut3d`-Knoten KANN eine eingebettete LUT normal verwenden.
- `graph.json → fallback.cube` KANN auf eine LUT zeigen, die **nur den Farbanteil** des Graphen enthält: alle `color.*`-Knoten, alle räumlichen Knoten auf Bypass. Diese LUT wird für Hosts ohne `.buck`-Leser gebacken, zum Beispiel für das heutige OFX-Plugin oder eine native Resolve-/Baselight-LUT. Ein- und Ausgangsraum MÜSSEN in `fallback` stehen und mit den Cube-Kommentaren übereinstimmen.
- Ein Reader, der den Graphen versteht, MUSS den Graphen rendern und DARF den Fallback nicht stillschweigend verwenden. Eine Ausnahme ist §5.5 (unbekannte Engine-Version), mit sichtbarer Warnung.

---

## 4. `graph.json` – Struktur und Versionierung

### 4.1 Oberste Ebene

| Feld | Typ | Bedeutung |
|---|---|---|
| `format` | `"buck"` | Pflicht |
| `formatVersion` | `"MAJOR.MINOR"` | Spezifikationsversion, hier `"1.0"` |
| `minReaderVersion` | `"MAJOR.MINOR"` | Älteste Readerversion, die alles Pflichtige versteht |
| `meta` | Objekt | Name, Autor, Erzeuger, Erstellzeit (ISO 8601), Prompt, Thumbnails, Lizenzhinweis |
| `colorManagement` | Objekt | Eingang, Ausgang, Arbeitsräume (§8) |
| `inputs` | Objekt | Deklarierte Bild- und Hilfskanäle (§6) |
| `models` | Objekt | Gepinnte Schätzmodelle (§6.3) |
| `nodes` | Array | Knoten (§5) |
| `output` | Knotenreferenz | Ergebnis des Graphen |
| `fallback` | Objekt, optional | Fallback-Cube (§3.4) |
| `timing` | Objekt, optional | Bezug für Keyframes (§9.3) |

### 4.2 Versionierungsregeln

- **Format:** Ein neues MINOR fügt nur optionale Felder und neue Knotentypen hinzu. Ein neues MAJOR darf Bedeutungen ändern. Ein Reader MUSS eine Datei mit unbekanntem MAJOR ablehnen. Eine Datei, deren `minReaderVersion` über der eigenen Version liegt, MUSS er ebenfalls ablehnen.
- **Knotentypen** werden einzeln versioniert, als `typ@N`, z. B. `atmos.fog@1`. Jede Änderung, die Pixelwerte verändert, erhöht `N`. Dazu zählen auch Bugfixes in der Referenzimplementierung. Ein Host KANN mehrere Versionen parallel implementieren. Alte Dateien rendern damit unverändert weiter. Diese Regel gilt ab Format 1.0. Im Entwurf 0.x sind die Knotenversionen vorläufig: Die Referenzmathematik darf sich noch ändern, ohne `N` zu erhöhen; jede solche Änderung steht in §14.0.
- **Unbekannte Knoten:** Ein Knoten mit `"optional": true` wird überbrückt, also Eingang = Ausgang, Maske = 0, mit Warnung. Bei einem Pflichtknoten MUSS der Reader den Render verweigern. Ein stilles Weglassen ist verboten.
- **Unbekannte Felder** in bekannten Knoten MUSS der Reader ablehnen, außer unter `x-<vendor>`. Damit wird kein vermeintlich verstandener Parameter ignoriert.
- Das JSON-Schema liegt künftig unter `docs/schema/buck-1.0.schema.json`. Es ist für Version 1 noch nicht geschrieben (§14, Phase 1).

### 4.3 Graph-Regeln

- Der Graph ist ein **gerichteter azyklischer Graph (DAG)**. Ein Reader MUSS Zyklen ablehnen. Die Auswertungsreihenfolge ergibt sich aus der topologischen Sortierung. Bei Gleichstand gilt die Reihenfolge im Array, das macht die Reihenfolge deterministisch.
- **Ports sind typisiert.** `image` ist RGB float, optional mit Alpha, das unverändert durchgereicht wird. `scalar` ist ein einkanaliges Float-Feld (Tiefe, Maske). `vector3` ist ein dreikanaliges Feld (Normalen). Verbindungen zwischen verschiedenen Typen sind ungültig.
- Jeder `image`-Knoten hat einen optionalen Port `mask` (`scalar`, 0…1). Das Ergebnis ist `mix(input, effect, mask * amount)`. Diese Mischung findet im Arbeitsraum des Knotens statt.
- Jeder Knoten hat `amount` (0…1, Standard 1) und `enabled` (Standard `true`).
- **Grenzen:** höchstens 64 Knoten, Verschachtelungstiefe des JSON ≤ 16, `graph.json` ≤ 256 KiB.

### 4.4 Räumliche Einheiten

Alle räumlichen Parameter sind **auflösungsunabhängig**:

- Längen werden in Bruchteilen der **Bildbreite** angegeben (`0.01` = 1 % der Breite). Damit ergeben 2K, UHD und Proxy dasselbe Bild.
- Bildkoordinaten sind normiert: (0,0) ist oben links, (1, Höhe/Breite) unten rechts. Das Pixelseitenverhältnis wird vor der Verarbeitung auf quadratische Pixel umgerechnet.
- Winkel stehen in Grad. Lichtstärken stehen in Blendenstufen (EV, Faktor 2^EV).
- Tiefe hat entweder die Einheit „normierte Szenentiefe“ (0 = nächster, 1 = fernster relevanter Punkt des Shots, §6.2) oder Meter, wenn `metric` deklariert ist.

---

## 5. Knotentypen (Version 1)

Für jeden Knoten werden Parameter, Wertebereich und Referenzmathematik angegeben. „Linear“ meint den szenenbezogenen linearen Arbeitsraum aus `colorManagement.working.linear` (§8).

### 5.1 Struktur eines Knotens

```json
{
  "id": "fog",
  "type": "atmos.fog@1",
  "inputs": {"image": "relight", "depth": "$depth", "mask": "bgMask"},
  "params": { "...": "..." },
  "amount": 1,
  "enabled": true,
  "optional": false,
  "label": "Nebel Hintergrund"
}
```

`inputs` verweisen auf Knoten-IDs oder mit `$name` auf deklarierte Eingaben (§6). `$source` ist das Host-Bild.

### 5.2 Farbstufe

#### 5.2.1 `color.look@1`

Diese Stufe ist der Buckswood-Look aus `src/color/look.ts` (`applyLook`) in der Fassung vom 30.10.2026.

- Raum: display-bezogen, standardmäßig `Rec.1886 Rec.709 - Display`. So arbeitet die heutige Engine.
- Parameter: genau `LookSpec`. `shadows`, `midtones` und `highlights` sind RGB-Offsets ohne Luma-Anteil (je −0,3…0,3). Dazu kommen `whiteClean` und `skinProtect` (0…1) sowie `skinHue`, `key`, `contrast` und `saturation` (−1…1). Hinzu kommt `skinProtection` (0…1, entspricht dem Settings-Wert).
- Optional `prompt` (Text, ≤ 2000 Zeichen) und `understood` (Liste) als Dokumentation. Diese Felder haben keine Renderwirkung. Der Graph enthält immer die aufgelösten Zahlen, ein Reader interpretiert den Prompt nie neu.
- `bakedLut` (optional) verweist auf eine LUT unter `luts/`, die genau diesen Knoten enthält. Ein Host KANN sie statt der Formel verwenden, wenn er die Formel nicht implementiert. Er SOLL dann die Toleranz nach Klasse A' (§7.2) einhalten.

#### 5.2.2 `color.lut3d@1`

Wendet eine eingebettete Cube-LUT tetraedrisch an. Das Verhalten entspricht dem Kernel in `native/ofx`: Werte außerhalb der Domain werden geklemmt, die Ausgabe wird nicht geklemmt. Parameter: `file`, `inputSpace`, `outputSpace`.

#### 5.2.3 `color.cdl@1`

ASC CDL mit Slope, Offset, Power je Kanal und Sättigung mit Rec.709-Lumagewichten, Stil `v1.2_Fwd` mit Klemmung oder `noClampFwd`. Parameter: `slope[3]`, `offset[3]`, `power[3]`, `saturation`, `style`, `space`.

#### 5.2.4 `color.convert@1`

Farbraumkonvertierung zwischen zwei in §8 erlaubten Namen. Dieser Knoten ist der **einzige** Ort, an dem der Graph Farbräume wechselt. Andere Knoten führen keine impliziten Konvertierungen durch.

### 5.3 Räumliche Effekte

#### 5.3.1 `atmos.fog@1` – Nebel und Atmosphäre, tiefenbasiert

- Eingänge: `image` (linear), `depth` (`scalar`), optional `mask`.
- Parameter:
  - `model`: `"exponential"` (Standard) oder `"linear"`.
  - `start` und `end`: Tiefe, ab der der Nebel beginnt bzw. bei `linear` voll ist, in normierter Tiefe oder in Metern.
  - `density`: Extinktion pro Tiefeneinheit (0…20).
  - `color`: Streulichtfarbe, linear im Arbeitsraum, oder `{"kelvin": K}`.
  - `luminance`: Helligkeit des Streulichts in EV relativ zu 18 % Grau.
  - `maxOpacity`: 0…1, begrenzt die Deckung im Unendlichen.
  - `skyProtect`: 0…1, hält Bereiche mit ungültiger oder unendlicher Tiefe zurück.
- Referenzmathematik je Pixel:
  `d' = max(0, d − start)`;
  exponentiell: `T = exp(−density · d')`; linear: `T = 1 − clamp(d' / (end − start))`;
  `T = 1 − maxOpacity · (1 − T)`;
  `out = in · T + color · 0.18 · 2^luminance · (1 − T)`.
- Grenzen: Der Nebel ist ein Screen-Space-Effekt. Er streut kein Licht von Lichtquellen (keine Lichtkegel) und berücksichtigt keine Verdeckung im Volumen. Höhennebel lässt sich mit einer Gradientenmaske (§5.4) annähern.

#### 5.3.2 `lens.dof@1` – Tiefenschärfe mit Fokus, Blende und Bokeh

- Eingänge: `image` (linear), `depth`, optional `mask` (Maske 0 = scharf lassen).
- Modus `physical` setzt metrische Tiefe voraus:
  - `focusDistance` in Metern, `fNumber`, `focalLength` in Millimetern, `sensorWidth` in Millimetern.
  - Zerstreuungskreis nach dünner Linse: `c = |f² · (d − s)| / (N · d · (s − f))`. Dabei ist `f` die Brennweite, `N` die Blendenzahl, `s` die Fokusdistanz und `d` die Tiefe.
  - In Bildbreiten umgerechnet: `c_w = c / sensorWidth`.
- Modus `artistic` (Standard bei relativer Tiefe):
  - `focus` (normierte Tiefe), `focusRange` (Tiefenbereich, der scharf bleibt).
  - `blurNear` und `blurFar`: Zerstreuungskreis in Bildbreiten am nächsten bzw. fernsten Punkt.
  - `c_w` steigt zwischen `focus ± focusRange/2` und den Enden glatt an (smoothstep).
- Gemeinsame Parameter:
  - `maxBlur`: Obergrenze in Bildbreiten, Standard 0,02.
  - Bokeh: `blades` (0 = Kreis, 5…12), `rotation` (Grad), `bladeCurvature` (0…1), `catEye` (0…1, Abschattung zum Rand), `highlightBoost` (0…1, verstärkt helle Lichtpunkte vor dem Blur, nur linear sinnvoll).
- Referenzalgorithmus: Gather-Filter in getrennten Tiefenschichten, Vorder- und Hintergrund getrennt, mit fester Abtastung. Ein deterministisches Vogel-Spiralmuster mit festgelegter Abtastzahl abhängig von `c_w` wird auf die Bokeh-Form abgebildet. Zufalls-Abtastung ist verboten (§9). Die genaue Schichtzahl, die Gewichtung an Kanten und der Umgang mit Vordergrund-Ausbluten werden in der Referenzimplementierung festgelegt und gehören zur Knotenversion.
- Grenzen: Hinter Vordergrundobjekten fehlt Bildinformation. Bei starkem Vordergrund-Blur entstehen deshalb Kantenartefakte. Haare und transparente Kanten sind mit einer einzelnen Tiefe pro Pixel nicht korrekt darstellbar.

#### 5.3.3 `light.relight@1` – Relight über Normalen

- Eingänge: `image` (linear), `normals` (`vector3`, Kameraraum), optional `depth` (für Abfall mit Entfernung) und `mask`.
- Normalenkonvention: Kameraraum, +X rechts, +Y oben, +Z zur Kamera, Einheitsvektoren. Ungültige Normalen sind (0,0,0) und erhalten keinen Effekt.
- Parameter:
  - `azimuth` in Grad: 0 = aus Kamerarichtung, −90 = von links, +90 = von rechts, ±180 = Gegenlicht.
  - `elevation` in Grad: 0 = Horizont, +90 = von oben.
  - `color` (linear) oder `{"kelvin": K}`.
  - `intensity` in EV.
  - `softness` (0…1): Wrap-Faktor `w = softness` und zusätzlich eine Glättung der Normalen mit Radius `softness · 0.01` Bildbreiten.
  - `mode`: `"add"` (Standard; Licht wird hinzugefügt) oder `"reshape"` (vorhandene Schattierung wird teilweise ersetzt, §15 Frage 8).
  - `preserveHighlights` (0…1).
  - `skinProtect` (optional, 0…1, animierbar): Hautschutz. Fehlt das Feld, gilt 0; das Ergebnis ist dann bitgleich zur Fassung ohne dieses Feld. Optionales Feld nach §4.2 (neues MINOR), daher bleibt die Knotenversion `@1`.
- Referenzmathematik `add`:
  `L` ist der Lichtvektor aus `azimuth` und `elevation`.
  `lambert = max(0, (dot(n, L) + w) / (1 + w))`.
  `albedo ≈ in / max(ε, Y(in_lowpass))` ist eine grobe Albedo-Schätzung aus dem Verhältnis von Bild und tiefpassgefilterter Luminanz. Der Tiefpassradius ist fest in der Knotenversion.
  `out = in + albedo · color · (2^intensity − 1) · 0.18 · lambert`.
  Dazu kommt `(1 − preserveHighlights · smoothstep(0,5; 1; Y(in)))` als Faktor auf `lambert` (Referenzimplementierung).
- Hautschutz, wenn `skinProtect` > 0: `s = skinProtect · 0,85 · skinKey(c)`. `c` ist der Pixel, umgerechnet nach `Rec.1886 Rec.709 - Display` (Codewerte); `skinKey` ist der weiche Farbschlüssel aus `src/color/look.ts`, derselbe wie bei `color.look@1` (Rot > Grün > Blau in begrenztem Abstand, mittlere Sättigung, Luma zwischen 0,04 und 0,98). Er ist **kein Gesichts- oder Hauterkenner**: Holz, Sand oder Ziegel in Hauttönen werden ebenfalls geschützt, gefärbte Haut unter farbigem Licht eventuell nicht. Auf solchen Pixeln wird die Lichtfarbe zu einem Neutral gleicher Luminanz gezogen, `color' = color + s · (Y(color) − color)`, und das zugefügte Licht auf `1 − s/2` gedämpft. Ohne Hautton (`s = 0`) bleibt die Formel unverändert.
- Grenzen: Relight ändert keine Schattenwürfe, Spiegelungen oder Subsurface-Streuung. In Version 1 entstehen keine Schatten. Die Albedo-Schätzung ist heuristisch. Der Hautschutz mildert Farbstich und Überstrahlung auf Haut, ersetzt aber kein Licht, das für Gesichter gesetzt wurde (§15 Frage 8).
- Editor-Funktion: „Hauttöne schützen“, „Hautschutz“ oder „protect skin“ im Prompt setzt `skinProtect: 1` auf dem Relight (auch auf dem Mond- oder Sonnenlicht des Tageszeit-Schalters) und wie bisher den Hautschutz im Look.

#### 5.3.4 `sky.replace@1` – Himmel ersetzen, tiefenbasiert

- Eingänge: `image` (linear), `depth` (`scalar`) und/oder `sky` (`scalar`, Wahrscheinlichkeit 0…1 aus einer Himmelssegmentierung, §6.5), mindestens einer der beiden; optional `mask`. Ist `sky` verbunden, gilt `R = 1` für `sky ≥ 0,5` statt der Tiefenregel in Schritt 1, `skyDepth` wirkt dann nicht. `mask` und `amount` mischt der Renderer wie bei jedem Bildknoten **nach** dem Knoten (§5.1). Der Knoten selbst liest `mask` nicht, damit sie nicht doppelt wirkt.
- Parameter:
  - `source`: `"procedural"` oder `"image"`; bei `"image"` ist `file` (`skies/<name>.png`, §3.2) Pflicht.
  - `preset`: `night`, `starry-night`, `moonrise`, `twilight`, `blue-hour`, `golden-hour`, `overcast`, `clear-day`, `storm`, `sandstorm`, `aurora` oder `neon-night`. Hat keine Renderwirkung, dokumentiert nur die Herkunft der Werte. Alle Werte stehen explizit im Knoten. Die Vorlagenwerte sind redaktionell und gehören zum Editor, nicht zum Format.
  - `zenith`, `horizon`: Farbe oben bzw. am Horizont, linear im Arbeitsraum oder `{"kelvin": K}`, relativ zu 18 % Grau.
  - `horizonY` (optional): Horizonthöhe in Bildbreiten (0 = oberer Rand). Fehlt der Wert, gilt der automatische Horizont: die Unterkante der untersten Pixelzeile, deren Himmelsanteil mindestens 1/64 beträgt (ohne Himmel H/(2W)).
  - `gradientPower` (0,05…10), `exposure` (EV), `glow` (0…8) und `glowColor`: Horizontglühen.
  - `stars` (0…1, Dichte), `milkyWay` (0…1), `clouds` (Bedeckung 0…1), `cloudContrast` (0…1), `cloudScale` (Bildbreiten), `cloudColor`, `aurora` (0…4).
  - `moon` (optional): `{x, height, radius, intensity, color?}`. Dabei ist `x` normiert, `height` die Höhe der Mondmitte über dem Horizont in Bildbreiten, `radius` in Bildbreiten und `intensity` in EV relativ zu 0,18. `color` ist standardmäßig 4100 K (Mondlicht). `height` ist relativ zum Horizont statt absolut angegeben, damit ein Mondaufgang auch beim automatischen Horizont knapp über der Kante bleibt.
  - `skyDepth`: Tiefe, ab der zusätzlich Himmel gilt. Werte > 1 erfassen bei normierter Tiefe nur die ungültige Tiefe (Standard 2).
  - `edge`: halbe Breite des Kantenbands in Bildbreiten (0 = harte, bereinigte Tiefenmaske; Standard der Vorlagen 0,01).
  - `spill` (0…1): dezente Färbung der Szene mit der mittleren Himmelsfarbe, an der Himmelskante am stärksten.
- Referenzmathematik:
  1. Rohmaske `R = 1`, wo `d` nicht endlich ist oder `d ≥ skyDepth`, sonst 0.
  2. Bereinigung: Von den 4-zusammenhängenden Komponenten von `R` bleiben die, die den oberen Bildrand berühren, und alle übrigen, deren Schwerpunktzeile nicht unter der untersten Zeile dieser Randkomponenten liegt (Lücken zwischen Ästen, eingeschlossene Löcher). Tiefer liegende Inseln, typisch der im Wasser oder Glas gespiegelte Himmel, entfallen. Berührt keine Komponente den oberen Rand, bleibt `R` unverändert. Das Ergebnis heißt `R′`; Horizont (`horizonY` automatisch) und `spill` verwenden `R′`.
  3. Matte: Mit `b = round(edge · W)` px liegt das Band zwischen Dilatation und Erosion von `R′` (quadratisch, Radius `b`). Außerhalb des Bands gilt `α = R′`. `S` ist der lokale alte Himmel (maskierter Gauß-Mittelwert von `in · erode(R′)`, σ = 2b), `F` der lokale Vordergrund (dasselbe mit `1 − dilate(R′)`). Im inneren Band (Radius `round(b/2)`) gilt die Farbschätzung `p = conf · a + (1 − conf) · R′` mit `a = smoothstep(0,15; 0,6; ⟨in − F, S − F⟩ / |S − F|²)` (zur Himmelsseite verschoben: Horizontdunst ist heller als der Himmelskern `S`) und `conf = smoothstep(0,005; 0,03; |S − F|² / (Y(S)² + Y(F)² + 10⁻⁶)) · (1 − smoothstep(0,25; 1; e² / |S − F|²))`, wobei `e` der Abstand des Pixels von der Geraden durch `F` und `S` ist (eine dritte Farbe, etwa eine Wolke, überlässt die Entscheidung der Maske), sonst `p = R′`. Danach der farbgeführte Guided Filter (He, Sun, Tang 2013, Alg. 2; schnelle Variante mit Unterabtastung `s = max(1, ⌊r/3⌋)` nach He & Sun 2015) mit Radius `r = max(1, round(b/3))`, `ε = 10⁻³` und der Kubikwurzel des linearen Eingangs als Führungsbild: `α = clamp(smoothstep(0,1; 0,9; GF(p)); min(p, M); max(p, M))` im Band, mit `M` = Kastenmittel von `R′` über denselben Radius `r`: Der Filter entscheidet nur, wo Farbschätzung und Maske uneins sind, und eine Kante ohne Farbkontrast bleibt geglättet statt binär. Die Kante folgt damit den Kanten des Bilds, nicht dem groben Tiefenraster.
  4. Komposit: `out = (1 − α) · F′ + α · sky`. Für 0 < α < 1 ist `u = (in − α · S) / (1 − α)` der entmischte Vordergrund. `F′ = in + t · (u − in)` mit dem größten `t ∈ [0, 1]`, für das alle drei Kanäle im Intervall zwischen `in` und `F` bleiben: ein gemeinsamer Faktor statt kanalweiser Begrenzung, damit der Farbton erhalten bleibt (kanalweise Begrenzung erzeugte Farbsäume). Für α = 0 gilt `out = in` bitgleich.
  5. Prozeduraler Himmel, je Pixel mit `u = (x + 0,5)/W`, `v = (y + 0,5)/W` und `base = 0,18 · 2^exposure`: `sky = mix(zenith, horizon, clamp(v/horizonY)^gradientPower) · base`, dazu `glow · glowColor · base · e^(−(horizonY − v)/0,06)`. Wolken: fBm aus 5 Oktaven Value-Noise (Integer-Hash, quintische Interpolation) mit Domain-Warp auf dem Gitter `X = (u − 0,5) · 0,6/cloudScale`, `Z = 0,24 · √(1/(horizonY − v + 0,12))/cloudScale`, Schwelle `smoothstep(1 − clouds ∓ w)` mit `w = 0,03 + 0,35 · (1 − cloudContrast)`. Sterne: festes Gitter mit der Zellgröße 1/512 Bildbreite; Stern, wenn `hash(i, j, 1) < 0,06 · stars · (1 + 6 · Milchstraßenband)`; Position und Helligkeit aus weiteren Hashes; Gauß-Fleck mit σ = max(0,0003 · W, 0,6) px und konstantem Fluss. Milchstraße, Polarlicht (zwei Vorhänge, grün unten, violett oben) und Mond (Scheibe mit Halo) sind ebenfalls feste Formeln dieser Knotenversion. Alles ist lineares Licht. Es gibt keine Zufallszahlen; das Muster hängt nur von normierten Koordinaten ab (§7).
  6. `source: "image"`: PNG als sRGB dekodiert und in den Arbeitsraum gewandelt, mit „Füllen“ eingepasst, mal `2^exposure`.
  7. `spill`: `in · (1 + k · (T − 1))` mit `T` = maskengewichteter Mittelwert des neuen Himmels auf Luminanz 1 normiert und `k = spill · (0,35 + 0,65 · clamp(2 · gauss(R′, 0,08 W)))`.
- Grenzen: Ein schmaler Kantenhalo bleibt möglich, vor allem wo die Tiefe die Kante grob trifft oder Himmel und Vordergrund ähnliche Farben haben (Dunst am Horizont). Haare, Äste und Laub vor dem Himmel werden nur so gut wie die Tiefe und das Farbband erfassen. Spiegelungen des Himmels, etwa im Wasser, werden **nicht** ersetzt (die Bereinigung in Schritt 2 entfernt sie auch dort, wo das Tiefenmodell sie für Himmel hält). Wolken, die das Tiefenmodell nicht als fern einstuft, bleiben als Reste an der Kante; zuverlässig trennt sie nur ein eigenes Himmelssegmentierungsmodell. Das Licht der Szene ändert sich nicht von selbst: Sonne und Schatten bleiben. Für eine glaubwürdige Tageszeit braucht es deshalb Grade, Belichtung und Relight.
- Editor-Funktion, nicht Teil des Formats: Der Text-Prompt erkennt Tageszeiten und Himmel auf Deutsch und Englisch (z. B. „Nacht“, „Sonnenuntergang“, „blaue Stunde“, „bewölkt“, „Sternenhimmel“, „Sandsturm“, „Gewitterhimmel“, „Polarlicht“, „Mondaufgang“, „Neon-Nacht“). Er schreibt daraus gewöhnliche Knoten, und zwar dieselben wie der Tageszeit-Schalter (§5.7): `sky.replace@1` mit Vorlage, bei dunklen Himmeln eine Belichtung als `color.cdl@1` im linearen Raum (Day-for-Night etwa −1,8 EV, kühl), eine eigene Grade-Verschiebung als `color.look@1` vor einem genannten Film-Look (dessen Tönung behält Vorrang, die Tageszeit wirkt dann mit 60 %) und gegebenenfalls Mondlicht oder tiefe Sonne als `light.relight@1`. Die Reihenfolge folgt den Ebenen (§5.6): Retusche → Belichtung → Relight → Lampen → Himmel → Nebel → Tiefenschärfe → Vignette → Halation → Korn → Display → Grade → Look. Der Himmel liegt vor dem Nebel, damit Dunst auch über dem neuen Himmel liegt.

#### 5.3.5 `light.practicals@1` – Lampen im Bild leuchten lassen und umfärben

- Eingänge: `image` (linear), optional `depth`, `normals` und `mask`. `mask` und `amount` wirken wie bei jedem Bildknoten nach dem Knoten.
- Parameter:
  - Erkennung: `threshold` (lineare Luminanz), `softness` (EV-Breite der Schwelle), `contrast` (EV über dem Gauß-Umfeld mit σ = `maxSize`), `minSize` und `maxSize` (Bildbreiten).
  - Leuchten: `intensity` (EV), `glow` und `glowRadius` (Bildbreiten), `throw` (Reichweite in Bildbreiten), `falloff` (0…3).
  - Farbe: `color` (linear oder Kelvin), `recolor` (0 = Originalfarbe, 1 = Zielfarbe).
  - `points` (optional, höchstens 8): `{x, y, radius, intensity, color?}` in normierten Koordinaten für Lampen, die die Erkennung nicht findet.
- Referenzmathematik:
  1. `c₀ = smoothstep(thr · 2^−softness, thr · 2^softness, Y) · smoothstep(2^(contrast−0,5), 2^(contrast+0,5), Y / gauss(Y, maxSize · W))`.
  2. `m = clamp(open(c₀, round(minSize · W)) − open(c₀, round(maxSize · W)))`, mit Graustufen-Öffnung (Erosion, dann Dilatation) mit einem Quadrat. Das Ergebnis enthält nur Strukturen zwischen Mindest- und Höchstgröße.
  3. Umfärben bei gleicher Luminanz: `rc = in + recolor · (Y · T/Y(T) − in)`. Bild: `in + m · (rc − in) + m · rc · g` mit `g = 2^intensity − 1`. Emission `E = m · rc` plus Punkte (weiche Scheibe in Punktfarbe, `0,18 · 2^intensity` je Punkt).
  4. Glühen: `g · glow · Σ wₖ · gauss(E, glowRadius · {0,5; 1; 2} · W)` mit `w = {0,5; 0,3; 0,2}`.
  5. Raumlicht: `room = Σ ŵₖ · gauss(E, σₖ) · 2π(σₖ/W)²/4·10⁻⁴` mit `σₖ = throw · {0,25; 0,5; 1} · W` und `ŵₖ ∝ 2^(−2 · falloff · k)`. Addiert wird `in · room · g / gauss(Y, 0,02 W)` (Albedo-Schätzung wie §5.3.3). Mit `depth` wird zusätzlich mit `exp(−((d − D_src)/0,25)²)` gewichtet; dabei ist `D_src` die emissionsgewichtete Quelltiefe. Mit `normals` wird gewichtet mit `max(0, (n · L + 0,5)/1,5)`; `L` zeigt entlang des Bildgradienten von `room` zur Quelle.
  6. Große Gauß-Radien dürfen über Verkleinern (Box), Gauß und bilineare Vergrößerung angenähert werden; diese Annäherung gehört zur Knotenversion.
- Grenzen: Die Erkennung ist heuristisch. Fenster, Himmel, Spitzlichter oder weiße Wände können fälschlich als Lampe gelten; dagegen helfen Schwelle, Kontrast oder eine Maske. Eine im Bild unbeleuchtete Lampe wird nicht gefunden; dafür gibt es `points`. Es gibt keinen echten Lichttransport, keine Verdeckung und keine neuen Schatten. Das Raumlicht ist ein Screen-Space-Effekt. Bei display-bezogenem Eingang sind Lampen meist bei 1,0 abgeschnitten, ihre wahre Helligkeit ist also unbekannt.
- Editor-Funktion: Der Prompt erkennt „Lampen an/leuchten“, „Lichter an“, „Praktikabel“, „Kerzenlicht“, „Neonlicht“, „Lampen in Rot/Blau/Türkis …“, „lamps on“, „practical lights“ (Chip z. B. „Lampen leuchten · warm 2700 K“). Nach einer Nacht-Belichtung folgt `threshold` ihr, damit dieselben Lampen gefunden werden.

#### 5.3.6 `lens.vignette@1` – Randabfall

- Eingänge: `image` (linear), optional `mask`. `mask` und `amount` mischt der Renderer nach dem Knoten.
- Parameter (Längen in Bildbreiten, §4.4):
  - Genau eines von `strength` (−1…1, Faktor) oder `exposure` (−8…4 EV). Ein Reader MUSS eine Datei mit beiden oder keinem der beiden ablehnen.
  - `radius` (0…2): Abstand von der Mitte, ab dem der Abfall beginnt.
  - `softness` (0…2): Breite des Übergangs. 0 ist eine harte Kante.
  - `roundness` (0…1): 0 folgt dem Bildformat (Ellipse, die die Bildränder gleich trifft), 1 ist ein Kreis.
  - `center` (optional, `[x, y]` in normierten Koordinaten §4.4): fehlt der Wert, gilt die Bildmitte `[0,5; H/(2W)]`.
- Referenzmathematik je Pixel mit `u = (x + 0,5)/W`, `v = (y + 0,5)/W`:
  `k = 1 + (W/H − 1) · (1 − roundness)`; `d = hypot(u − cx, (v − cy) · k)`; `f = smoothstep(radius, radius + softness, d)`;
  `gain = 1 − strength · f` (nie negativ) bzw. `gain = 2^(exposure · f)`; `out = in · gain`, Alpha unverändert.
- Grenzen: Ein parametrischer Abfall, kein Objektivmodell. Das natürliche cos⁴-Gesetz, mechanische Vignettierung oder Farbsäume am Rand bildet der Knoten nicht nach. Negative `strength` hellt die Ränder auf. Wirkt der Knoten nach dem Nebel, dunkelt er auch den Nebel ab, wie es ein Objektiv tut.
- Editor-Funktion: „Vignette“, „Vignettierung“, „Randabdunklung“, „dunkle Ecken“, „vignetting“, „dark corners“ ergeben `exposure: −1` EV (leicht −0,5, stark −1,8), „rund“ setzt `roundness: 1`, „weich“/„hart“ die Übergangsbreite.

#### 5.3.7 `film.grain@1` – Filmkorn

- Eingänge: `image` (linear), optional `mask`.
- Parameter:
  - `size` (0,0002…0,01): Zellgröße des Korngitters in Bildbreiten. 0,0007 entspricht etwa 1,3 px bei 1920 px Breite (35-mm-Anmutung).
  - `intensity` (0…2): Stärke als Standardabweichung in EV bei voller Tongewichtung. 0,08 EV entspricht in den Mitten etwa 2,3 % des Display-Codewerts.
  - `response` (0…1): Luminanzabhängigkeit. 0 = überall gleich stark, 1 = Tongewicht des Boolean-Modells (unten).
  - `chroma` (0…1): 0 = monochromes Korn (alle Kanäle gleich), 1 = unabhängiges Korn je Kanal.
  - `seed` (ganze Zahl 0…65535): wählt ein anderes Muster, z. B. je Shot.
  - `animate` (Wahrheitswert): `true` = Korn ändert sich mit jedem Frame, `false` = stehendes Korn.
- Hintergrund: Newson et al. modellieren Filmkorn als Boolean-Modell, also als Vereinigung zufällig platzierter Scheiben (Silberkörner), deren Dichte so gewählt ist, dass die erwartete Bedeckung dem Grauwert entspricht. Gerendert wird mit Monte-Carlo-Integration und einem Gauß-Filter; das Ergebnis ist auflösungsunabhängig ([Realistic Film Grain Rendering, IPOL 7 (2017), S. 165–183, DOI 10.5201/ipol.2017.192](https://www.ipol.im/pub/art/2017/192/article_lr.pdf)). Daraus übernimmt `@1` zwei Eigenschaften: Die Varianz der Bedeckung eines Boolean-Modells ist `u · (1 − u)`, also null bei Schwarz und Weiß und am größten in den Mitten. Außerdem hängt das Muster an Bildkoordinaten und nicht an Pixeln. Die Monte-Carlo-Simulation einzelner Körner übernimmt `@1` nicht: Sie ist teuer und braucht Zufallszahlen. Stattdessen nutzt `@1` gauß-gefiltertes weißes Rauschen auf einem festen Gitter.
- Referenzmathematik:
  1. Gitterwerte: `g(i, j, s) = 2 · (h(i, j, s) + h(i, j, s + 1) + h(i, j, s + 2) − 1,5)` mit dem Integer-Hash `h` aus §5.3.4 (murmur3-Finalizer). Das ist eine Irwin-Hall-Näherung einer Normalverteilung mit Varianz 1.
  2. Seed je Feld: `s = (imul(seed ⊕ 0x5bd1e995, 0x27d4eb2d) ⊕ imul(⌊frame⌋, 0x165667b1) ⊕ imul(k + 1, 0x9e3779b1))` mit `k` = Kanal 0–2 bzw. 3 für das monochrome Feld und `frame = 0` bei `animate: false`. `frame` ist die Frame-Nummer des Renders (§9.3). Gleiche Frame-Nummer bedeutet gleiches Korn, auch bei getrennten Renderinstanzen.
  3. Feld: Zelle `(i, j)` deckt `[i, i+1) · size × [j, j+1) · size` in Bildbreiten und trägt den Wert `g(i, j, s)`. Jeder Pixel erhält den flächengewichteten Mittelwert der Zellen, die er überdeckt (exakt, getrennt nach x und y). Danach folgt ein Gauß-Filter mit `σ = 0,5 · size · W` px, wie bei Newson et al. ein einzelner Gauß-Filter. Das Ergebnis wird mit `1/0,48606` multipliziert: Für `σ = 0,5` Zellen ist der mittlere Wert von `Σᵢ (Φ((i+1−x)/σ) − Φ((i−x)/σ))²` über eine Zelle 0,48606 pro Achse; so hat das kontinuierliche Feld den Effektivwert 1. Sind Zellen kleiner als ein Pixel, mitteln sie sich im Pixel heraus. Ein Proxy-Render zeigt dadurch dasselbe Muster verkleinert, mit kleinerer Streuung pro Pixel, wie ein verkleinerter Filmscan.
  4. Farbe: `G_c = ((1 − chroma) · G_mono + chroma · G_c,unabhängig) / hypot(1 − chroma, chroma)`; bei `chroma = 0` gilt `G_c = G_mono`.
  5. Tongewicht: `t = clamp(Y(in))^(1/2,4)` (display-ähnlicher Ton), `u = t^0,7`, `w = 2 · √(u · (1 − u))`, `w' = 1 + response · (w − 1)`. Der Exponent 0,7 verschiebt das Maximum der Boolean-Varianz von `t = 0,5` nach `t ≈ 0,37`, also in Richtung Schatten. Das ist eine redaktionelle Entscheidung.
  6. `out_c = in_c · 2^(intensity · w' · G_c)`. Alpha bleibt unverändert, Schwarz bleibt Schwarz.
- Grenzen: Ein statistisches Ersatzmodell, kein Kornsimulator. Es gibt keine einzelnen Körner, keine log-normale Korngrößenverteilung und keine Abhängigkeit von Filmmaterial oder Entwicklung. Auf display-bezogenem SDR-Material wirkt `t` wie der Codewert, auf Szenenlicht über 1 entsteht kein Korn. Das quadratische Zellraster ist nach dem Gauß-Filter nur noch schwach zu ahnen; bei starker Vergrößerung kann es sichtbar werden. Komprimierte Ausgabe (H.264/HEVC) glättet Korn stark; das gehört nicht zum Format.
- Editor-Funktion: „Filmkorn“, „Korn“, „körnig“, „film grain“, „grainy“. Ein Filmformat wählt Größe und Stärke (redaktionell): Super 8 0,0022/0,22 EV, 16 mm 0,0013/0,14 EV, 35 mm 0,0007/0,08 EV (Standard), 65/70 mm und IMAX 0,0004/0,05 EV. „fein“/„grob“ skalieren die Größe (×0,75/×1,4), „leicht“/„stark“ die Stärke (×0,6/×1,6); `chroma` ist 0,2, „monochrom“ setzt 0, „farbig“ 0,7. Beispiel: „Kodak-Look mit Korn“ ergibt den Look plus Korn davor.

#### 5.3.8 `film.halation@1` – Halation und Bloom

- Eingänge: `image` (linear), optional `mask`.
- Hintergrund: Bei Farbnegativfilm durchdringt helles Licht die Emulsion, wird an der Rückseite des Trägers reflektiert und belichtet von hinten vor allem die rotempfindliche Schicht nach. Um Spitzlichter entsteht dadurch ein rötlich-oranger Hof ([Halation, Wikipedia](https://en.wikipedia.org/wiki/Halation)). Bloom ist hier das allgemeine, farbneutrale Überstrahlen heller Stellen.
- Parameter:
  - `threshold` (0,01…16): lineare Luminanz, ab der ein Pixel als Spitzlicht zählt.
  - `knee` (0…6 EV): Breite des weichen Übergangs um die Schwelle.
  - `radius` (0…0,1): Größe des Hofs in Bildbreiten.
  - `intensity` (0…4): Stärke des Hofs.
  - `color`: Farbe des Hofs (linear oder Kelvin), auf Luminanz 1 normiert.
  - `bloom` (0…2): Anteil des neutralen Bloom, 0 = aus.
  - `bloomRadius` (optional, 0…0,1): Radius des Bloom; fehlt der Wert, gilt `radius`.
- Referenzmathematik:
  1. `k = smoothstep(−knee/2, knee/2, log₂(Y/threshold))` (0 für `Y ≤ 0`; 0,5 genau an der Schwelle).
  2. `B(E, r) = Σ wₖ · gauss(E, r · {0,5; 1; 2} · W)` mit `w = {0,25; 0,5; 0,25}`, große Radien wie in §5.3.5 über Verkleinern, Gauß und Vergrößern (`gaussianBlurWide` der Referenz).
  3. `E = Y · k`; `out = in + intensity · ĉ · max(0, B(E, radius) − E) + bloom · B(in · k, bloomRadius)`, mit `ĉ = color / Y(color)`. Alpha bleibt. Der Hof zählt nur das Licht, das über seine Quelle hinaus streut: Innerhalb einer gleichmäßig hellen Fläche ist `B(E) ≈ E`, dort entsteht kein Hof, an ihren Rändern und um kleine Spitzlichter schon. Das ist eine bewusste Abweichung von der reinen Streuung: Auf SDR-Material liegen Wolken und weiße Wände nahe der Schwelle und würden sonst rosa überzogen.
- Grenzen: Additiv und ohne Energieerhaltung: Der Hof nimmt dem Spitzlicht kein Licht weg. Der Bloom wirkt dagegen auch im Inneren heller Flächen und kann sie bei hohen Werten aufhellen. Auf display-bezogenem Material sind Spitzlichter bei 1,0 beschnitten; ihre wahre Helligkeit ist unbekannt, daher ist die Schwelle dort ein Gestaltungswert. Physikalisch hängt Halation von Material, Belichtung und Lichthofschutzschicht ab; `@1` bildet das nicht nach.
- Editor-Funktion: „Halation“, „Lichthof“, „Halo“ ergeben einen roten Hof (`intensity` 0,6, Radius 0,006); „Bloom“, „Glow“, „Glühen“, „Überstrahlen“ einen neutralen Bloom (`bloom` 0,3, `bloomRadius` 0,012). „Lampen glühen“ bleibt `light.practicals@1`.

#### 5.3.9 `fill.inpaint@1` – Retusche aus einer vorbereiteten Platte

- Eingänge: `image` (beliebiger Raum), `plate` (Bild, Pflicht; in der Regel eine deklarierte Bild-Eingabe, §6.5), optional `mask`.
- Keine Parameter.
- Referenzmathematik: Ausgabe ist `plate`, umgerechnet in den Raum von `image` (§8); Alpha kommt aus `image`. Wo die Platte erscheint, bestimmen wie bei jedem Bildknoten `mask` und `amount` (§5.1), üblicherweise dieselbe Region, aus der die Platte gefüllt wurde (`mask.input@1` der Lochmaske → `mask.refine@1` mit derselben Erweiterung und einer weichen Kante).
- Der Knoten führt kein Modell aus. Die Platte ist Shot-Material wie die Tiefe: Sie stammt aus dem Analyse-Cache oder einer Schätzung (§6.5), der Render bleibt dadurch deterministisch. Fehlt sie, wird der Knoten nach `onMissing` überbrückt.
- Editor-Funktion „Motiv entfernen“: Motivmaske (`$subject`) → Platte (`$plate`, MI-GAN) → `fill.inpaint@1` als erster Knoten der Bildkette, vor jeder Belichtung: Alles Spätere muss auch auf die Platte wirken, sonst bleibt ein heller Geist in Form des Motivs.

### 5.4 Masken (`scalar`-Ausgang)

| Typ | Parameter | Zweck |
|---|---|---|
| `mask.depthRange@1` | `near`, `far`, `feather` (Tiefeneinheiten), `invert` | Vorder-, Mittel- und Hintergrund trennen |
| `mask.gradient@1` | `shape` (`linear`/`radial`), `start`/`end` bzw. `center`/`radius` in normierten Koordinaten, `feather`, `invert` | Vignette, Himmel, Höhennebel |
| `mask.luma@1` | `low`, `high`, `softness`, `space` | Lichter oder Schatten begrenzen |
| `mask.input@1` | `input` (`$name` einer deklarierten Maske), `channel` | Host- oder Rotomaske verwenden |
| `mask.image@1` | `file` (`masks/*.png`), `fit` (`stretch`/`contain`/`cover`) | Statische Formmaske |
| `mask.combine@1` | `op` (`multiply`, `max`, `min`, `subtract`, `screen`), Eingänge `a`, `b` | Masken verknüpfen |
| `mask.refine@1` | `blur` (Bildbreiten), `grow` (±), `gamma` | Weichzeichnen und Erweitern |

Jede Maske wird auf 0…1 geklemmt. `feather` nutzt immer `smoothstep`, wie `smooth()` in `src/color/spaces.ts`.

### 5.5 Engine-Bindung des Farblooks

`color.look@1` ist an eine konkrete Formel gebunden. Damit ein Host ohne eigene Implementierung arbeiten kann, SOLL der Writer `bakedLut` (64³, wie der heutige Standardexport) mitliefern. Kennt ein Host `color.look@1` nicht, DARF er `bakedLut` verwenden, MUSS das aber anzeigen. Als Pflichtknoten ohne `bakedLut` führt er sonst zur Renderverweigerung (§4.2).

### 5.6 Ebenen der Bildkette (Editor)

Die Knoten folgen dem Weg des Lichts. Der Editor gruppiert die Bildkette sichtbar in vier Ebenen. Die Ebenen sind eine Editor-Konvention und **nicht Teil des Formats**: Ein Reader wertet weiterhin nur den Graphen aus (§4.3), und eine Datei darf ihre Knoten in jeder gültigen Reihenfolge enthalten.

| Ebene | Knoten | Raum | Umgesetzt |
|---|---|---|---|
| **Licht** | `color.cdl@1` im linearen Raum (Szenenbelichtung), `light.relight@1`, `light.practicals@1` | linear | ja |
| **Atmosphäre** | `sky.replace@1`, `atmos.fog@1` | linear | ja |
| **Optik** | `lens.dof@1`, `lens.vignette@1`, `film.halation@1`, `film.grain@1` | linear | ja; chromatische Aberration, Linsenverzeichnung und Lens Flares noch nicht |
| **Grade** | `color.look@1`, `color.cdl@1` im Display-Raum, `color.lut3d@1` | display | ja |

- Konvertierungen (`color.convert@1`) und unbekannte optionale Knoten haben keine eigene Ebene. Der Editor zeigt sie bei der nächsten Ebene, die folgt. Masken stehen getrennt.
- **Hinzufügen:** Ein neuer Knoten kommt ans Ende seiner Ebene. Innerhalb der Optik gilt Objektiv vor Film (Tiefenschärfe → Vignette → Halation → Korn), im Licht Belichtung → Relight → Lampen, in der Atmosphäre Himmel → Nebel. Eine Konvertierung direkt davor wird übersprungen, wenn ihr Ausgangsraum nicht der Raum des neuen Knotens ist; ein linearer Knoten landet so vor der Display-Konvertierung des Grades. Ist ein Knoten derselben Ebene ausgewählt, kommt der neue direkt dahinter.
- **Bestehende Dateien** werden nicht umsortiert. Weicht ihre Reihenfolge von Licht → Atmosphäre → Optik → Grade ab, zeigt der Editor die Abschnitte in Dateireihenfolge und kennzeichnet Abschnitte, die hinter einer späteren Ebene stehen.
- Begründung der Reihenfolge: Korn und Halation entstehen im Negativ, also vor der Lichtbestimmung; der Grade wirkt deshalb auch auf das Korn. Ein Grade vor dem Korn ist möglich (Datei-Reihenfolge), gilt aber als Abweichung.

### 5.7 Tageszeit-Schalter (Editor)

Oben in der Knotenliste wählt der Nutzer eine Tageszeit: „Wie aufgenommen“, „Goldene Stunde“, „Mittag“ (Vorlage `clear-day`), „Blaue Stunde“, „Zwielicht“, „Nacht“, „Sternenhimmel“, „Mondaufgang“, „Bewölkt“, „Gewitter“, „Sandsturm“, „Polarlicht“ oder „Neon-Nacht“. Der Schalter ist eine Editor-Funktion (`applyTimeOfDay` in `src/buck/prompt.ts`; der Text-Prompt nutzt dieselbe Funktion). Sein Ergebnis sind gewöhnliche Knoten; die Spezifikation bleibt unverändert.

- Er erzeugt je nach Vorlage: `tod-exposure` (Szenenbelichtung, `color.cdl@1` linear, Anfang der Ebene Licht), `tod-light` mit Maske `tod-lightMask` (Mondlicht bzw. tiefe Sonne, nur wenn der Graph kein eigenes Relight hat), `tod-sky` (`sky.replace@1`, Anfang der Atmosphäre), `tod-haze` (Staub beim Sandsturm, wenn kein Nebel da ist) und `tod-grade` (`color.look@1`, Anfang des Grades, vor einem vorhandenen Look; mit vorhandenem Look wirkt die Tönung mit 60 %).
- **Kennzeichnung:** Die Knoten-IDs beginnen mit `tod-`. Dieses Präfix ist für den Schalter reserviert. Vorhandene Knoten, die er anpasst, behalten die ersetzten Werte im Herstellerfeld `x-buckswood-tod` (§4.2), z. B. `{"params": {"luminance": 1.6}, "label": "Nebel im Hintergrund"}`; `null` steht für „Feld fehlte“. Angepasst werden die Nebelhelligkeit (und die Nebelfarbe, wenn sie noch der Standardfarbe entspricht), die Schwelle von `light.practicals@1` nach einer Szenenbelichtung und ein vorhandenes `sky.replace@1` (Vorlagenwerte; Quelle, Datei, Horizont, Tiefenschwelle und Kante bleiben).
- **Wechsel und Rücknahme:** Jede Wahl entfernt zuerst die Spuren der vorigen (alle `tod-`-Knoten, Rückschreiben aus `x-buckswood-tod`) und setzt dann die neue Vorlage. Vorlagen stapeln sich also nicht. „Wie aufgenommen“ entfernt nur. Werte, die der Nutzer nach dem Schalten an angepassten Feldern geändert hat, werden dabei auf den Stand vor dem Schalter zurückgesetzt; andere Felder bleiben.
- Ein Look, dessen Bildknoten keine einfache Kette bilden, lässt sich nicht schalten; der Editor meldet das.

---

## 6. Deklarierte Eingaben und Hilfskanäle

### 6.1 Deklaration

`inputs` nennt jedes Signal, das der Graph außer dem Host-Bild braucht:

```json
"inputs": {
  "depth":   {"kind": "depth",   "semantics": "relative-inverse", "required": false,
              "sources": [ … ], "normalize": { … }, "onMissing": "bypass-dependents"},
  "normals": {"kind": "normals", "frame": "camera", "required": false, "sources": [ … ]},
  "subject": {"kind": "mask",    "required": false, "sources": [{"type": "host-clip", "clip": "Mask"}]}
}
```

- `kind`: `depth`, `normals`, `mask` oder `image` (ein Bild in Quellgröße, etwa eine retuschierte Platte, §6.5; `onMissing: "constant"` ist für Bilder nicht erlaubt).
- `semantics` bei Tiefe:
  - `relative-inverse`: affin-invariante inverse Tiefe (Disparität), wie relative Mono-Depth-Modelle sie liefern.
  - `relative-depth`: wachsend mit der Entfernung, ohne Skala.
  - `metric`: Meter.
- `sources` ist eine **geordnete** Liste. Der Host nimmt die erste verfügbare Quelle:
  1. `{"type": "host-clip", "clip": "Depth"}`: vom Host geliefert, z. B. ein OFX-Zusatzclip oder ein EXR-AOV aus einer CG-Szene. Für CG-Material ist das die beste Quelle.
  2. `{"type": "cache"}`: vorhandener Analyse-Cache, passend zur Look-ID und zur Medienidentität (§6.4).
  3. `{"type": "derive", "method": "normals-from-depth@1", "from": "depth", "params": {…}}`: nur für Normalen; aus dem Tiefengradienten der unter `from` genannten Eingabe, deterministisch bei gleicher Tiefe.
  4. `{"type": "estimate", "model": "<id aus models>"}`: ML-Schätzung, deren Ergebnis den Cache füllt. Das Modell muss zur Art passen: Tiefenmodelle für `depth`, Segmentierung (`output: "probability"`) für `mask`, Retusche (`output: "image"`) für `image`. Bei `image` ist `"hole": {"input": "<Masken-Eingabe>", "grow": <0…0,1>}` Pflicht: Die Lochmaske ist die genannte Masken-Eingabe, Schwelle 0,5, um `grow` Bildbreiten erweitert.
- `onMissing`: `"fail"`, `"bypass-dependents"` (Standard; alle abhängigen Knoten werden überbrückt, mit Warnung) oder `"constant"` (z. B. Tiefe = 1, nur für Tests).

### 6.2 Normierung der Tiefe

Relative Modelle liefern pro Bild eine unbekannte Skala und Verschiebung. Das ist die Hauptursache für zeitliches Flackern. Version 1 schreibt deshalb vor:

- `normalize.mode = "shot-percentile"`: Über **alle Frames des Shots** werden ein gemeinsames unteres und oberes Perzentil (Standard 2 % / 98 %) ermittelt. Bei `relative-inverse` geschieht das auf der inversen Tiefe vor der Umrechnung. Danach wird mit **einer** Skala und Verschiebung pro Shot auf 0…1 abgebildet, 0 = nah. Die Werte werden im Cache gespeichert.
- `normalize.mode = "per-frame"` ist erlaubt, flackert aber erwartungsgemäß und ist nur für Standbilder gedacht.
- `normalize.mode = "none"` gilt für `metric`.
- Ungültige oder unendliche Werte, z. B. Himmel, werden als `+Inf` markiert und von §5.3.1 `skyProtect` behandelt.

### 6.3 Gepinnte Modelle

```json
"models": {
  "vda-small-rel@1": {
    "name": "Video-Depth-Anything-Small (relativ)",
    "upstream": "https://github.com/DepthAnything/Video-Depth-Anything",
    "revision": "<Git-Commit der Gewichte>",
    "license": "Apache-2.0",
    "format": "onnx",
    "opset": 17,
    "weightsSha256": "<SHA-256 der ONNX-Datei>",
    "output": "relative-inverse",
    "preprocess": {"longSide": 518, "multipleOf": 14, "resize": "bicubic", "inputSpace": "sRGB - Texture",
                   "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
    "temporal": {"windowFrames": 32, "overlapFrames": 8},
    "postprocess": {"resize": "bilinear-to-source"}
  }
}
```

Regeln:

- Die Gewichte sind **nicht** in der `.buck` enthalten. Gründe: Größe, Lizenz und der Ausschluss ausführbarer Inhalte, denn ein ONNX-Graph ist ein Rechenprogramm. Der Host verwaltet ein lokales Modellregister. Er führt ein Modell nur aus, wenn `weightsSha256` exakt passt.
- Ein fehlendes Modell lädt der Host **nie automatisch** herunter. Der Nutzer muss es ausdrücklich installieren, über Buckswood-eigene Paketierung mit festem Hash.
- Vorverarbeitung, Fensterung und Nachverarbeitung gehören zum Pin. Ein anderer Resize ergibt eine andere Tiefe.
- **Lizenzlage der Kandidaten** (geprüft am 30.10.2026, vor Release erneut prüfen):
  - [Video Depth Anything](https://github.com/DepthAnything/Video-Depth-Anything) ([Paper](https://arxiv.org/abs/2501.12375)): Code Apache-2.0, Modell **Small Apache-2.0**, **Base/Large CC-BY-NC-4.0** (nicht kommerziell). Die Lizenz der metrischen Varianten wird auf der Projektseite nicht genannt. Das Modell hat einen zeitlichen Kopf und einen experimentellen Streaming-Modus, der laut Projekt schlechter abschneidet als der Offline-Modus. Standardkandidat für Version 1 ist daher **Small, relativ, offline**.
  - [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2): Small Apache-2.0, größere Modelle CC-BY-NC-4.0. Ohne zeitlichen Kopf; nur für Standbilder sinnvoll.
  - [Apple Depth Pro](https://github.com/apple/ml-depth-pro): metrische Tiefe und Brennweitenschätzung aus einem Bild. Eigene Apple-Lizenz, die kommerzielle Nutzung und Weitergabe der Gewichte nicht ausdrücklich regelt. Vor Verwendung ist eine rechtliche Prüfung nötig. Ohne zeitliche Konsistenz.
  - Normalen: In Version 1 werden sie **aus der Tiefe abgeleitet** (`normals-from-depth@1`). Das ist günstig, deterministisch und zeitlich so stabil wie die Tiefe. [Marigold Normals](https://huggingface.co/prs-eth/marigold-normals-v0-1) (Apache-2.0, diffusionsbasiert und langsam) sowie [DSINE](https://github.com/baegwangbin/DSINE) (Lizenz nicht geprüft) sind Kandidaten für Phase 4.
- Laufzeit im Web: [ONNX Runtime Web mit WebGPU-Execution-Provider](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html). Nativ: ONNX Runtime mit CoreML oder CPU. Die Ergebnisse sind zwischen diesen Backends **nicht bit-gleich** (§7.3).

### 6.4 Analyse-Cache (`.buckaux`)

Der Cache ist nicht Teil der `.buck`-Datei. Er wird pro Shot erzeugt:

- **Schlüssel:** Medienidentität (Dateiname, Dateigröße, Hash der ersten und letzten MiB, Timecode-Bereich, Auflösung), Modell-ID mit `weightsSha256`, Normierungsparameter und Ableitungsparameter. Die Look-ID gehört nicht dazu: Derselbe Tiefencache dient mehreren Looks.
- **Inhalt:** OpenEXR pro Frame oder als Multi-Part-Sequenz, Kanäle `depth.Z` (float32) und `N.X`/`N.Y`/`N.Z` (half), Auflösung höchstens Quellauflösung. Dazu `aux.json` mit Normierung (Skala/Verschiebung pro Shot), Modell-Pin und Erzeugerversion.
- Der Cache ist **unveränderlich**. Ändert sich ein Schlüsselteil, entsteht ein neuer Cache.
- Ein Host MUSS den Cache auch für den Render ohne ML verwenden können. Das ermöglicht Baselight-Renderknoten ohne GPU-Inferenz.

---

### 6.5 Segmentierung und Retusche

Neben Tiefe kann ein Modell Masken und Bilder liefern. Für sie gelten dieselben Regeln wie in §6.3 (Pin mit `weightsSha256`, kein automatischer Download, Ergebnis ist Shot-Material im Cache). Zusätzliche Felder im Pin:

- `output`: `"probability"` (eine Wahrscheinlichkeit 0…1 je Pixel) oder `"image"` (sRGB, 8 Bit).
- `preprocess.fit`: `"aspect"` (Standard: lange Seite = `longSide`, Seitenverhältnis bleibt), `"stretch"` (`longSide × longSide`) oder `"native"` (Quellgröße, Eingabe als uint8-Codewerte; das Modell skaliert intern, `mean`/`std` wirken nicht).
- `postprocess.activation`: `"sigmoid"`, wenn das Modell Logits liefert.

Registrierte Modelle des Referenz-Editors (geprüft am 03.11.2026 über die Hugging-Face-API und den SHA-256 der Dateien):

| ID | Zweck | Datei, Größe | Lizenz | Vorverarbeitung |
|---|---|---|---|---|
| `skyseg-u2net@1` | Himmel samt Wolken, unabhängig von der Tiefe | [voyagerfromeast/skyseg](https://huggingface.co/voyagerfromeast/skyseg) `skyseg_fp16.onnx`, 88 MB, opset 11 | MIT (Ursprung [xiongzhu666/Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing), U²-Net) | 320 × 320 gestreckt, ImageNet-Normierung, erste Ausgabe |
| `isnet-general@1` | Hauptmotiv (Person, Objekt), Standard im Editor | [danielgatis/rembg, Release v0.0.0](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) `isnet-general-use.onnx`, 179 MB, opset 13; SHA-256 selbst berechnet, MD5 entspricht der Prüfsumme in rembg | **Kommerziell ungeklärt** (siehe unten) | 1024 × 1024 gestreckt (bilinear), /255, Mittel 0,5, Std 1, erste Ausgabe |
| `birefnet-lite@1` | Hauptmotiv, Alternative mit klarer Lizenz; der Editor erkennt die Datei am Hash | [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) `onnx/model_fp16.onnx`, 115 MB, opset 17 | MIT ([BiRefNet](https://github.com/ZhengPeng7/BiRefNet)) | 1024 × 1024 gestreckt, ImageNet-Normierung, Sigmoid |
| `migan-512@1` | Retusche einer Lochmaske | [andraniksargsyan/migan](https://huggingface.co/andraniksargsyan/migan) `migan_pipeline_v2.onnx`, 28 MB, opset 17 | MIT ([Picsart MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN)) | Quellgröße als uint8, Maske 255 = behalten, 0 = füllen; die Pipeline schneidet auf das Loch zu und füllt mit 512 × 512 |

Hinweise:

- **Kein Zufall, kein Seed.** MI-GAN und LaMa sind vorwärtsgerichtete Netze ohne Rauscheingang; gleiche Eingabe ergibt auf demselben Backend dieselbe Platte. Diffusionsmodelle mit festem Seed sind dagegen zwischen GPUs und Backends nicht bit-gleich und widersprechen §7. Sie kommen höchstens später als Toleranzklasse C mit gecachter Platte in Frage.
- **ControlNet** (Canny, Tiefe) steuert die Bildgenerierung eines Diffusionsmodells; für Masken bringt es nichts. Masken werden mit Segmentierungsmodellen und der kantengeführten Matte (§5.3.4) besser.
- **Lizenz von `isnet-general@1`** (geprüft am 04.11.2026): Das [DIS-README](https://github.com/xuebinqin/DIS) stellt nur „code and evaluation metric“ unter Apache-2.0. Eine eigene Lizenz der Gewichte nennt es nicht. Die [Nutzungsbedingungen des Trainingsdatensatzes DIS5K](https://github.com/xuebinqin/DIS/blob/main/DIS5K-Dataset-Terms-of-Use.pdf) erlauben nur nichtkommerzielle Forschung und Lehre. Die [Anfrage zur kommerziellen Nutzung dieser Gewichte](https://github.com/xuebinqin/DIS/issues/150) ist offen und vom Autor unbeantwortet. Für kommerzielle Arbeit daher die Rechtslage klären oder `birefnet-lite@1` (MIT) verwenden.
- **Lauffähigkeit** (geprüft auf einem Apple-Mac mit ONNX Runtime Web 1.31): `isnet-general@1` läuft über WebGPU (8 s) und auf der CPU (124 s unter Last). `birefnet-lite@1` läuft dort nicht: In WebAssembly reichen die 4 GB Adressraum nicht, und ein WebGPU-Shader braucht 11 Storage-Buffer, Apple-GPUs bieten 10. Himmelssegmentierung und MI-GAN laufen auf GPU und CPU.
- **Analyse auf der Platte:** Sobald ein Motiv entfernt ist, gehört jede Analyse auf die Platte: Himmelsmaske und Tiefe zeigen sonst noch das Motiv, und an seiner Stelle bleibt alter Himmel stehen oder eine Silhouette im Licht. Der Editor erkennt den Himmel automatisch neu und berechnet die Behelfstiefe neu. Eine Modelltiefe füllt er im Loch aus der Umgebung und bittet um eine neue Schätzung, die dann auf der Platte läuft. Beim Entfernen der Retusche gilt dasselbe in umgekehrter Richtung.
- **Grenzen:** Segmentierung und Retusche arbeiten pro Bild, ohne zeitliche Glättung. Auf Video flackern Masken und Platte (§9); MI-GAN füllt große Löcher mit 512 px Auflösung und dadurch weicher als die Umgebung. Der Analyse-Cache des Referenz-Editors (§6.4) speichert Masken bereits, Bild-Eingaben noch nicht.

## 7. Determinismus und Referenz-Shader

### 7.1 Normative Grundlage

1. **Mathematik in diesem Dokument und in der Knotenversion** ist normativ.
2. **Referenzimplementierung:** skalares C++ mit float32, ohne Fast-Math, mit `-ffp-contract=off`, fester Auswertungsreihenfolge und festen Abtastmustern. Geplanter Ort: `native/ofx/src/buck/`, wiederverwendbar außerhalb von OFX. Sie ist der „Referenz-Shader“. GPU-Implementierungen (WGSL im Web, Metal nativ) sind Portierungen und werden gegen sie gemessen.
3. **Konformitätssuite:** Testbilder (16-Bit-PNG und EXR mit Tiefe/Normalen), `.buck`-Dateien und erwartete Ausgaben der Referenz, geplant in `tests/buck-conformance/`. Ein Host gilt als konform zu einem Knoten `typ@N`, wenn alle Fälle in der Toleranzklasse liegen.

### 7.2 Toleranzklassen

Die Werte sind Vorschläge, die mit der Referenz in Phase 2 kalibriert werden:

| Klasse | Knoten | Bedingung | Toleranz gegenüber der Referenz (Ausgabe im Ausgangsraum, 0…1) |
|---|---|---|---|
| **A** | `color.look`, `color.cdl`, `color.convert`, `lens.vignette`, Masken ohne Blur | gleiche Eingabe | max. abs. ≤ 1e-5 (CPU), ≤ 1e-4 (GPU, float32) |
| **A'** | `color.look` über `bakedLut` (64³ tetraedrisch) | gleiche Eingabe | max. abs. ≤ 2/1023 (10 Bit), mittlere ≤ 1e-4 |
| **B** | `atmos.fog`, `lens.dof`, `light.relight`, `sky.replace`, `light.practicals`, `film.grain`, `film.halation`, `mask.refine` | **identische Hilfskanäle** (Korn: gleiche Frame-Nummer) | 99,9-Perzentil ≤ 1/1023, max. ≤ 4/1023; keine NaN/Inf |
| **C** | jede Kette mit `estimate`-Quelle | gleiches Modell, anderes Backend | keine Pixelgarantie; Plausibilitätstest (Rangkorrelation der Tiefe ≥ 0,99 gegen Referenz-CPU-Inferenz) |

### 7.3 Was Determinismus hier bedeutet

- Bei gleichem `.buck` und gleichem Analyse-Cache liefern alle konformen Hosts Klasse A bzw. B. **Das ist das Reproduzierbarkeitsversprechen von `.buck`.**
- ML-Inferenz auf verschiedenen Backends (WebGPU, CoreML, CUDA, CPU) und mit fp16 statt fp32 liefert verschiedene Zahlen. `.buck` verspricht hier nur Klasse C. Für exakte Übergabe zwischen Web-Editor und Resolve wird der Cache mitgegeben, nicht neu geschätzt.
- Verboten sind deshalb in allen Knoten: Zufallszahlen, zeitabhängige Seeds, Abhängigkeit von Kachelgrößen oder Thread-Anzahl bei Reduktionen, und hardwareabhängige Approximationen wie `exp`/`pow`-Intrinsics ohne Genauigkeitsgarantie in Klasse A. Pro Knoten wird die erlaubte Funktionsgenauigkeit festgelegt.
- Kachel- und ROI-Rendering (OFX) MUSS dasselbe Ergebnis liefern wie ein Vollbild-Render. Räumliche Knoten deklarieren dazu ihren maximalen Lesebereich (z. B. `maxBlur` + Rand) für `getRegionsOfInterest`.

---

## 8. Farbmanagement

- **Namen:** Farbräume werden mit Namen aus der OFX-1.5-Native-Config `ofx-native-v1.5_aces-v1.3_ocio-v2.3` bezeichnet. Diese basiert auf der OCIO-ACES-Studio-Config und liegt lokal unter `native/ofx/third_party/openfx/include/ofx-native-v1.5_aces-v1.3_ocio-v2.3.h`. Beispiele aus dem Header: `ACEScg`, `ACES2065-1`, `Rec.1886 Rec.709 - Display`, `sRGB - Display`, `lin_rec709_srgb`, `g24_rec709_tx`. Damit kann das OFX-Plugin die Räume direkt über `kOfxImageEffectPropColourManagementStyle` und `kOfxImageClipPropColourspace` aushandeln (`ofxColour.h`).
- **`colorManagement`:**
  ```json
  "colorManagement": {
    "config": "ofx-native-v1.5_aces-v1.3_ocio-v2.3",
    "input": "Rec.1886 Rec.709 - Display",
    "output": "Rec.1886 Rec.709 - Display",
    "working": {"linear": "ACEScg", "display": "Rec.1886 Rec.709 - Display"}
  }
  ```
- **Arbeitsräume pro Knotentyp:**
  - Physikalisch motivierte Knoten (`atmos.fog`, `lens.dof`, `light.relight`, `sky.replace`, `light.practicals`, `lens.vignette`, `film.grain`, `film.halation`) MÜSSEN linear arbeiten. Nebel und Bokeh in Gamma-Werten sehen sichtbar falsch aus, vor allem bei hellen Lichtpunkten.
  - `color.look@1` arbeitet display-bezogen, wie die heutige Engine.
  - Der Writer setzt `color.convert`-Knoten explizit. Ein Reader fügt nie selbst Konvertierungen ein.
- **Display-Eingang als „linear“:** Wenn das Host-Bild display-bezogen ist (heutiger SDR-Fall), ergibt die inverse EOTF nur *linearisiertes Display-Licht*, keine echte Szenenlinearität. Hellste Lichter sind dann bereits beschnitten. Das ist für Version 1 akzeptiert und im Editor sichtbar zu kennzeichnen. Für Log- und Kameramaterial SOLL der Eingang ein Szenenraum sein, z. B. `ACEScg` nach Host-IDT.
- **Hilfskanäle sind Daten, keine Farbe.** Auf Tiefe, Normalen und Masken DARF nie eine Farbraumkonvertierung angewendet werden. Für OFX-Clips muss der Host sie als „raw/data“ liefern (§15 Frage 2).
- **Farbparameter** (`color` in Nebel und Licht) werden im linearen Arbeitsraum angegeben. `{"kelvin": K}` wird über die Planck-Chromatizität (CIE 1931, 2°) in den Arbeitsraum umgerechnet und auf Luminanz 1 normiert. Gamut-Überschreitungen nach Relight werden nicht still geklemmt. Wie in `native/ofx` bleibt die Ausgabe ungeklemmt; Gamut-Mapping ist Sache des Ausgabetransforms.
- **HDR:** In Version 1 nicht spezifiziert. `color.look@1` ist eine SDR-Formel.

---

## 9. Zeitliche Stabilität

### 9.1 Problemquellen

1. Pro Frame unabhängige ML-Schätzung führt zu flackernder Tiefe. Das beeinflusst direkt Nebeldichte, Unschärfe und Lichtverlauf.
2. Normierung pro Frame verschiebt die Skala, z. B. wenn ein nahes Objekt ins Bild kommt.
3. Masken mit harten Schwellen an rauschenden Signalen erzeugen kriechende Kanten.
4. Zufällige Abtastung im DOF erzeugt Rauschen von Frame zu Frame.
5. Hostverhalten: Baselight rendert Frames in getrennten Instanzen, ohne sequentielle Reihenfolge.

### 9.2 Gegenmaßnahmen (normativ)

- Der Render ist **zustandslos**. Kein Knoten darf auf andere Frames zugreifen; `kOfxImageEffectPropTemporalClipAccess = 0`, wie heute. Alles Zeitliche geschieht im **Analyse-Durchlauf**, der den Cache schreibt.
- Das Standardmodell hat einen zeitlichen Kopf (Video Depth Anything), Inferenz in überlappenden Fenstern laut Pin (§6.3).
- Die Normierung gilt für den ganzen Shot (§6.2). Ein Shot-Wechsel braucht einen neuen Cache. Die Shot-Grenze kommt vom Host oder aus einer Schnitterkennung im Editor.
- Optional KANN der Analyse-Durchlauf eine bewegungskompensierte zeitliche Glättung anwenden: `stabilize: {"method": "flow-ema@1", "strength": …}`. Sie ist Teil des Cache-Schlüssels. Im Render ist sie verboten.
- Masken nutzen immer `feather` > 0. `mask.depthRange` verlangt ein Mindest-`feather` von 0,02 Tiefeneinheiten.
- Für DOF gelten feste Abtastmuster (§5.3.2). Fokusfahrten erfolgen über Keyframes, nicht über automatische Fokusverfolgung.
- Filmkorn (§5.3.7) ändert sich nur über die Frame-Nummer des Renders, nicht über einen Zustand. Zwei Renderinstanzen, die denselben Frame rechnen, liefern dasselbe Korn.

### 9.3 Animation

- Jeder numerische Parameter KANN statt einer Zahl ein Keyframe-Objekt sein:
  `{"keys": [[frame, value], …], "interp": "linear" | "hold" | "smooth"}`.
- `smooth` ist monotone kubische Hermite-Interpolation (Fritsch-Carlson), ohne Überschwingen.
- `timing.reference`: `"clip-start"` (Frame 0 = erster Frame des Clips im Host, Standard) oder `"timecode"` mit `timing.rate`. Keyframes sind nur in Shot-gebundenen Looks sinnvoll. Ein Look für mehrere Shots SOLL keine Keyframes enthalten.
- Ausdrücke wie `sin(t)` oder Verknüpfungen zwischen Parametern gibt es nicht (§11).

### 9.4 Abnahmemessung

- **Statischer Shot (Stativ, keine Bewegung):** Die mittlere absolute Differenz aufeinanderfolgender Ausgabeframes darf nur geringfügig über der des unbearbeiteten Materials liegen. Der Grenzwert wird in Phase 2 kalibriert.
- **Bewegter Shot:** Der bewegungskompensierte Fehler (Warping mit optischem Fluss) der Tiefe und der Ausgabe wird gemessen und protokolliert. Ein guter Wert auf einem einzigen Demo-Clip reicht nicht als Nachweis.

---

## 10. Performance-Ziele

Zielwerte, keine Messungen. Sie werden in Phase 2 und 3 auf benannter Hardware gemessen und hier nachgetragen:

| Pfad | Auflösung | Ziel | Bemerkung |
|---|---|---|---|
| Web-Vorschau, Farbe + Nebel, Tiefe aus Cache | 1920×1080 | ≥ 24 fps auf einem Apple-M1-Mac mit WebGPU | Fragment-Shader, Tiefe als Textur |
| Web-Vorschau, + DOF | 1920×1080 | ≥ 12 fps interaktiv, beim Loslassen voll | Vorschau DARF mit reduzierter Abtastung laufen, MUSS als Vorschau markiert sein; Export immer mit voller Referenzabtastung |
| Web, Tiefenschätzung | 518 px lange Seite | ≥ 5 Bilder/s auf M1 über WebGPU | Analyse-Durchlauf; Fortschritt und Abbruch sichtbar |
| OFX CPU, Farbe + Nebel | 3840×2160 | ≤ 250 ms/Frame auf 8 Kernen | Nutzt den Host-Thread-Pool wie heute |
| OFX CPU, alles inkl. DOF (`maxBlur` 0,02) | 3840×2160 | ≤ 2 s/Frame | Render-Farm-tauglich, nicht interaktiv |
| OFX GPU (Metal), alles | 3840×2160 | ≤ 40 ms/Frame | Phase 3b; Toleranz Klasse B |
| Speicher | UHD | ≤ 1 GiB zusätzlich pro Instanz | Tiefe float32, Normalen half |

Grundsätze: Die Kosten von DOF wachsen mit `maxBlur²`. Deshalb gilt eine harte Obergrenze (§5.3.2). Ein Proxy-Render (OFX `renderScale` < 1) MUSS dank der auflösungsunabhängigen Einheiten (§4.4) dasselbe Bild in kleiner liefern.

---

## 11. Sicherheit

`.buck`-Dateien kommen von Dritten, über Mail, Cloud-Ordner oder Projektarchive. Sie werden in Grading-Systemen mit wertvollem Material geöffnet. Regeln:

1. **Keine ausführbaren Inhalte:** keine Skripte, Shader-Quelltexte, Ausdrücke, Plugins, Modellgewichte, Makros und HTML/SVG. Knoten sind nur Typnamen aus einer festen Liste mit Zahlen-, Enum- und Dateiverweis-Parametern. Ein Reader MUSS alles andere ablehnen.
2. **Keine externen Verweise:** keine URLs und keine absoluten oder relativen Pfade außerhalb des Archivs. `upstream` in `models` ist reine Dokumentation und wird nie aufgerufen. Kein Netzwerkzugriff beim Öffnen oder Rendern.
3. **ZIP-Härtung:** Pfadvalidierung gegen Zip Slip, also Path Traversal beim Entpacken ([Hintergrund](https://www.theregister.com/2018/06/05/zip_slip_bug_archives)). Ein Reader SOLL ohnehin im Speicher lesen und nichts entpacken. Weitere Grenzen:
   - Archiv ≤ 128 MiB, ≤ 64 Einträge, einzelner Eintrag entpackt ≤ 64 MiB.
   - Kompressionsverhältnis pro Eintrag ≤ 100:1 gegen Zip-Bomben.
   - Lokaler und zentraler Header müssen übereinstimmen.
4. **Parser-Grenzen:** `graph.json` ≤ 256 KiB, JSON-Tiefe ≤ 16. Zahlen müssen endlich sein und im Wertebereich liegen; Bereichsprüfung wie heute in `src/recipe.ts`. Cubes werden mit den Grenzen des bestehenden Parsers gelesen (`native/ofx/README.md`). Bilder: höchstens 4096×4096, nur PNG/JPEG über bewährte Decoder, ohne Metadatenauswertung außer ICC zur Anzeige.
5. **Ressourcenbegrenzung beim Rendern:** feste Obergrenzen für Knotenzahl, Blur-Radius und Abtastzahl. Damit kann keine Datei einen Host absichtlich lahmlegen.
6. **Modelle:** Ausführung nur bei passendem Hash aus dem lokalen Register, kein automatischer Download (§6.3). Der ONNX-Laufzeit wird kein Inhalt aus der `.buck` übergeben.
7. **Integrität und Herkunft:** `manifest.json` sichert Integrität, nicht Herkunft. Eine optionale Signatur, z. B. Ed25519 unter `signatures/`, ist für Version 1 offen (§15 Frage 11).
8. **Datenschutz:** Thumbnails zeigen Produktionsmaterial. Der Writer SOLL beim Export fragen, ob Thumbnails eingebettet werden. `meta` enthält keine Systempfade oder Nutzernamen, außer der Nutzer trägt sie ausdrücklich ein.

---

## 12. Verteilung und Host-Integration

- **Web-Editor (`src/`):** Er schreibt und liest `.buck`, rechnet Vorschau in WebGPU und Analyse über ONNX Runtime Web und kann Cache sowie Fallback-Cube exportieren.
- **OFX-Plugin (`native/ofx/`):** Das bestehende Plugin `com.buckswood.autolut` bleibt der Cube-Lader. Ein neuer Effekt, Arbeitstitel `com.buckswood.buck`, liest `.buck`:
  - Kontext **General**: Quellclip plus optionale Clips `Depth`, `Normals` und `Mask` (`kOfxImageClipPropOptional = 1`, Maske mit `kOfxImageClipPropIsMask`). Kontext **Filter**: nur Quellclip, Hilfskanäle aus dem Cache.
  - Kein Temporal Clip Access, Thread-Sicherheit `FullySafe`, Kacheln mit deklarierter ROI (§7.3).
  - Farbmanagement über OFX 1.5, wenn der Host es anbietet. Sonst gilt der heutige Vertrag: Der Nutzer stellt Ein- und Ausgangsraum laut Datei ein, ohne implizite Konvertierung.
  - Keine ML-Inferenz im Render-Callback. Fehlt der Cache, zeigt das Plugin eine persistente OFX-Meldung mit dem Hinweis, den Shot im Editor zu analysieren, oder überbrückt abhängige Knoten laut `onMissing`.
- **Hosts ohne Plugin:** Fallback-Cube in der nativen LUT-Funktion. Die räumlichen Effekte fehlen dann, und der Export sagt das.
- **Spätere Exportziele (nicht Version 1):** CLF für den Farbanteil, DCTL für Resolve-only-Workflows ohne Plugin (räumliche Knoten mit Tiefe als Textur, sofern Resolve das zulässt), Nuke-Gizmo aus Standardknoten. Diese Exporte sind Übersetzungen mit eigener Konformitätsprüfung. In der `.buck` liegen sie nie.

---

## 13. Beispiel: „Fargo-Look + Nebel im Hintergrund + warmes Licht von links“

Annahmen: SDR-Material in Rec.709/Gamma 2.4, keine vom Host gelieferte Tiefe, Standbild oder ruhiger Shot. Die Farbwerte des Looks sind die tatsächlichen Werte des Fargo-Presets aus `src/color/prompt.ts`, berechnet mit `tintDirection` aus `src/color/look.ts`. Hashes und Commit-IDs sind **Platzhalter** und werden in Phase 2 beim ersten echten Pinnen ersetzt.

Graph: `$source` → Linearisieren → Relight (nur Vorder- und Mittelgrund) → Nebel (nur Hintergrund) → zurück nach Rec.709 → Fargo-Look → Ausgabe.

```json
{
  "format": "buck",
  "formatVersion": "1.0",
  "minReaderVersion": "1.0",
  "meta": {
    "name": "Fargo Winter · Nebel hinten · Warmlicht links",
    "generator": "Buckswood Auto LUT (Entwurf)",
    "created": "2026-10-30T12:00:00Z",
    "prompt": "Fargo-Look, Nebel im Hintergrund, warmes Licht von links",
    "thumbnails": {"before": "thumbs/before.jpg", "after": "thumbs/after.jpg"}
  },
  "colorManagement": {
    "config": "ofx-native-v1.5_aces-v1.3_ocio-v2.3",
    "input": "Rec.1886 Rec.709 - Display",
    "output": "Rec.1886 Rec.709 - Display",
    "working": {"linear": "ACEScg", "display": "Rec.1886 Rec.709 - Display"}
  },
  "inputs": {
    "depth": {
      "kind": "depth",
      "semantics": "relative-inverse",
      "required": false,
      "sources": [
        {"type": "host-clip", "clip": "Depth"},
        {"type": "cache"},
        {"type": "estimate", "model": "vda-small-rel@1"}
      ],
      "normalize": {"mode": "shot-percentile", "low": 2, "high": 98},
      "onMissing": "bypass-dependents"
    },
    "normals": {
      "kind": "normals",
      "frame": "camera",
      "required": false,
      "sources": [
        {"type": "host-clip", "clip": "Normals"},
        {"type": "cache"},
        {"type": "derive", "method": "normals-from-depth@1", "from": "depth", "params": {"smoothing": 0.002}}
      ],
      "onMissing": "bypass-dependents"
    }
  },
  "models": {
    "vda-small-rel@1": {
      "name": "Video-Depth-Anything-Small (relativ)",
      "upstream": "https://github.com/DepthAnything/Video-Depth-Anything",
      "revision": "PLATZHALTER-git-commit",
      "license": "Apache-2.0",
      "format": "onnx",
      "opset": 17,
      "weightsSha256": "PLATZHALTER-sha256-der-onnx-datei",
      "output": "relative-inverse",
      "preprocess": {
        "longSide": 518,
        "multipleOf": 14,
        "resize": "bicubic",
        "inputSpace": "sRGB - Texture",
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225]
      },
      "temporal": {"windowFrames": 32, "overlapFrames": 8},
      "postprocess": {"resize": "bilinear-to-source"}
    }
  },
  "nodes": [
    {
      "id": "toLinear",
      "type": "color.convert@1",
      "inputs": {"image": "$source"},
      "params": {"from": "Rec.1886 Rec.709 - Display", "to": "ACEScg"}
    },
    {
      "id": "nearMask",
      "type": "mask.depthRange@1",
      "inputs": {"depth": "$depth"},
      "params": {"near": 0.0, "far": 0.6, "feather": 0.12, "invert": false}
    },
    {
      "id": "warmKey",
      "type": "light.relight@1",
      "label": "Warmes Licht von links",
      "inputs": {"image": "toLinear", "normals": "$normals", "mask": "nearMask"},
      "params": {
        "azimuth": -70,
        "elevation": 20,
        "color": {"kelvin": 3200},
        "intensity": 0.8,
        "softness": 0.6,
        "mode": "add",
        "preserveHighlights": 0.7
      },
      "amount": 1
    },
    {
      "id": "bgMask",
      "type": "mask.depthRange@1",
      "inputs": {"depth": "$depth"},
      "params": {"near": 0.55, "far": 1.0, "feather": 0.15, "invert": false}
    },
    {
      "id": "fog",
      "type": "atmos.fog@1",
      "label": "Nebel im Hintergrund",
      "inputs": {"image": "warmKey", "depth": "$depth", "mask": "bgMask"},
      "params": {
        "model": "exponential",
        "start": 0.55,
        "density": 2.2,
        "color": [0.78, 0.84, 0.92],
        "luminance": 1.6,
        "maxOpacity": 0.75,
        "skyProtect": 0.3
      }
    },
    {
      "id": "toDisplay",
      "type": "color.convert@1",
      "inputs": {"image": "fog"},
      "params": {"from": "ACEScg", "to": "Rec.1886 Rec.709 - Display"}
    },
    {
      "id": "fargo",
      "type": "color.look@1",
      "label": "Fargo · kalte Winterpalette, sauberes Schnee-Weiß",
      "inputs": {"image": "toDisplay"},
      "params": {
        "space": "Rec.1886 Rec.709 - Display",
        "look": {
          "shadows": [-0.030672, 0.005846, 0.032405],
          "midtones": [-0.004179, 0.000107, 0.011248],
          "highlights": [0, 0, 0],
          "whiteClean": 0.8,
          "skinProtect": 0.6,
          "skinHue": 0,
          "key": 0.2,
          "contrast": -0.05,
          "saturation": -0.25
        },
        "skinProtection": 0.6,
        "prompt": "Fargo-Look",
        "understood": ["Basis: Fargo · kalte Winterpalette, sauberes Schnee-Weiß"],
        "bakedLut": "luts/fargo_look_rec709_64.cube"
      }
    }
  ],
  "output": "fargo",
  "fallback": {
    "cube": "luts/fargo_look_rec709_64.cube",
    "inputSpace": "Rec.1886 Rec.709 - Display",
    "outputSpace": "Rec.1886 Rec.709 - Display",
    "covers": ["fargo"],
    "omits": ["warmKey", "fog"]
  }
}
```

Hinweise zum Beispiel:

- „Von links“ bedeutet aus Sicht der Kamera. `azimuth = −70°` setzt das Licht etwas vor die Seitenebene, sodass Gesichter noch Licht abbekommen. Bei −90° wäre es reines Seitenlicht.
- Das warme Licht ist auf Vorder- und Mittelgrund maskiert, der Nebel auf den Hintergrund. Die Masken überlappen weich zwischen 0,55 und 0,6. So wird der Nebel nicht warm angestrahlt.
- Das Licht steht **vor** dem Fargo-Look. Der Look entsättigt (−0,25) und kühlt die Schatten. Das Warmlicht wird dadurch gedämpft, so wie bei einem Gel am Set mit anschließendem Grade. Wer das Warmlicht im Endbild unverändert sehen will, setzt den Relight-Knoten hinter den Look. Dann muss er im display-bezogenen Raum arbeiten, was für `light.relight@1` nicht erlaubt ist; es wäre ein Fall für eine spätere Knotenversion.
- Ohne Tiefe überbrückt der Host Relight, Nebel und beide Masken laut `onMissing`. Übrig bleibt der reine Fargo-Look, identisch mit dem Fallback-Cube.

---

## 14. Roadmap

### 14.0 Umsetzungsstand (Referenz-Prototyp, 31.10.2026)

Der Prototyp unter `src/buck/` ist eine TypeScript-Referenz im Browser und in Node. Er ist nicht die normative C++-Referenz aus §7.1.

- **Phase 1:** Spezifikation und JSON-Schema (`docs/schema/buck-1.0.schema.json`) liegen vor. Der strenge Reader `src/buck/validate.ts` prüft die semantischen Regeln. Offen sind die Formeln mit Funktionsgenauigkeiten pro Knoten und der 1.0-rc.
- **Phase 2, umgesetzt:** Lesen und Schreiben im Speicher (`container.ts`) mit den Grenzen aus §11, Tiefenschätzung über ONNX Runtime Web (WebGPU, sonst WASM) mit Depth Anything V2 Small (`da2-small-rel@1`; für Video Depth Anything gibt es keinen offiziellen ONNX-Export), Analyse-Cache in IndexedDB mit `.buckaux`-Export (EXR), alle Knoten aus §5 als TypeScript-Referenz (`render.ts`, `nodes/*`), Fallback-Cube, Keyframes, Editor mit Ebenen (§5.6) und Tageszeit-Schalter (§5.7). Vitest-Tests in `tests/buck-*.test.ts`.
- **Phase 2, offen:** WGSL-Vorschau, Kalibrierung der Toleranzklassen, Messung der Performance-Ziele (§10) auf benannter Hardware, Flackermessung nach §9.4.
- **Phase 4, teilweise:** `normals-from-depth@1`, `light.relight@1` (Modus `add`) mit optionalem Hautschutz (§5.3.3) und `light.practicals@1` gibt es im Web; Modus `reshape`, gelernte Normalen und die Prüfung durch einen Coloristen fehlen.
- **Optik (neu, §5.3.6–§5.3.8):** `lens.vignette@1`, `film.grain@1` und `film.halation@1` gibt es im Web und im Prompt („Filmkorn“, „35mm-Korn“, „Vignette“, „Halation“, „Bloom“, „Glow“). Chromatische Aberration, Verzeichnung, Flares und anamorphotische Effekte fehlen.
- **Phase 3** (OFX, C++-Referenz) hat noch nicht begonnen.
- **Segmentierung und Retusche (neu, §6.5, §5.3.9):** Eingabeart `image`, Schätzquellen für Masken und Bilder, Pins `skyseg-u2net@1`, `isnet-general@1`, `birefnet-lite@1`, `migan-512@1`, Knoten `fill.inpaint@1`, optionaler `sky`-Eingang an `sky.replace@1`. Im Editor das Panel „Masken & Retusche“.
- **Änderungen der Referenzmathematik im Entwurf:** 03.11.2026, `sky.replace@1`: Bereinigung der Himmelsmaske (gespiegelter Himmel entfällt), Matte aus Farbschätzung plus farbgeführtem Guided Filter statt Gauß-Kante, farbtonerhaltende Entmischung im Komposit, Standard `edge` der Vorlagen 0,004 → 0,01 (§5.3.4). Ohne Tiefenmodell sucht die Behelfstiefe den Himmel feiner (bis 1024 px, Wolken an Graten eingeschlossen).
- **Behelfstiefe im Editor** (nicht Teil des Formats, 05.11.2026): Ihre Flecken sind keine Flächen. Normalen daraus zeigten teils vom Licht weg und ließen beim Relight dunkle Flecken stehen. Der Editor setzt deshalb eigene Normalen: nur die Annahme „weiter oben im Bild = weiter weg“, je Spalte monoton und stark geglättet. Deklarierte Normalen leiten sich weiter aus der Tiefe ab (`normals-from-depth@1`). Die bildbasierte Himmelssuche verwirft zusätzlich Regionen anderer Farbe, etwa eine glatte Gewölbedecke am oberen Bildrand.

### Phase 1 – Spezifikation (dieses Dokument)

- Konzept, Container, Graph, Knoten, Eingaben, Determinismus, Farbmanagement, Sicherheit.
- **Noch offen in Phase 1:** JSON-Schema `docs/schema/buck-1.0.schema.json`, eine exakte Fassung der Formeln mit Funktionsgenauigkeiten pro Knoten, Entscheidung über die offenen Fragen (§15) in der Reihenfolge ihrer Relevanz.
- **Ausgang:** Spezifikation 1.0-rc mit Schema. Ein Validator kann gegen das Schema laufen. Beispiel aus §13 und zwei weitere Beispiele (nur Farbe; DOF mit Fokusfahrt) sind gültig.

### Phase 2 – Prototyp Nebel + Tiefenschärfe im Web-Editor (`src/`)

- Lesen und Schreiben von `.buck` im Speicher, ohne Entpacken auf die Platte, mit allen Grenzen aus §11. Ein Parser-Modul analog zu `src/recipe.ts`.
- Tiefenschätzung mit Video-Depth-Anything-Small über ONNX Runtime Web und WebGPU, mit Fallback auf WASM und Fortschrittsanzeige. Pinnen des echten Hashes; Lizenzprüfung im Paket.
- Analyse-Cache im Browser (IndexedDB) mit Export als `.buckaux` (EXR).
- Knoten `color.convert`, `color.look`, `mask.depthRange`, `mask.gradient`, `atmos.fog`, `lens.dof` (`artistic` zuerst) in WGSL, dazu eine TypeScript-Referenz für Tests, solange die C++-Referenz fehlt.
- Konformitätsfälle für Klasse A/B in `tests/` (Vitest). Messung der Performance-Ziele §10 auf benannter Hardware.
- **Ausgang:** Beispiel §13 ohne Relight (Nebel und Fargo) und eine DOF-Variante rendern im Editor. Export von `.buck`, Fallback-Cube und Cache. Flackermessung nach §9.4 auf mindestens drei Clips (statisch, Schwenk, Person im Vordergrund) dokumentiert.

### Phase 3 – OFX-Unterstützung (`native/ofx/`)

- C++-Referenzimplementierung (`native/ofx/src/buck/`) für alle Knoten aus Phase 2. Sie wird normative Referenz, die TS-Referenz wird dagegen geprüft.
- Neuer Effekt `com.buckswood.buck` (§12): `.buck`- und Cache-Leser, optionale Clips, ROI, OFX-1.5-Farbmanagement wo verfügbar.
- Phase 3a CPU, Phase 3b Metal.
- Hosttests in Resolve und Baselight macOS: Laden, Render, Kacheln, Proxy, Renderknoten ohne GPU, fehlender Cache. Für Baselight Linux ein separat gebautes Artefakt.
- **Ausgang:** Gleiches `.buck` und gleicher Cache ergeben in Web, Resolve und Baselight Klasse B gegen die Referenz, auf der Konformitätssuite und auf einem echten Projektframe.

### Phase 4 – Relight

- `normals-from-depth@1` und `light.relight@1` in Referenz, Web und OFX.
- Untersuchung, ob gelernte Normalen (Marigold, DSINE o. a.) lizenzrechtlich und zeitlich tragfähig sind. Der Modus `reshape`. (`skinProtect` für Relight ist seit 31.10.2026 als optionales Feld spezifiziert, §5.3.3.)
- **Ausgang:** Beispiel §13 vollständig in allen drei Hosts. Sichtprüfung an Porträt, Innenraum und Außen durch einen Coloristen, mit dokumentierten Grenzfällen (Haare, Brillen, Gegenlicht).

---

## 15. Offene Fragen

1. **Medientyp und Endung:** `application/vnd.buckswood.buck+zip` registrieren (IANA-Vendor-Baum) oder nur intern verwenden? Kollidiert `.buck` mit verbreiteten Endungen anderer Anwendungen?
2. **Hilfskanäle in OFX-Hosts:** Liefert Resolve auf der Color-Page zusätzliche Eingangsclips an einen OFX-Effekt zuverlässig, etwa die Ausgabe seines eigenen Depth-Map-Effekts, und liefert er sie ohne Farbraumkonvertierung als Daten? Wie verhält sich Baselight bei optionalen Clips? Beides ist nicht geprüft; davon hängt ab, ob `host-clip` in Version 1 praktisch nutzbar ist.
3. **Cache-Transport:** Soll eine `.buck` optional die Hilfskanäle *eines* Shots einbetten (Archivpaket „Look + Shot“) oder bleibt `.buckaux` immer getrennt? Einbettung bläht die Datei stark auf, vereinfacht aber die Übergabe.
4. **Medienidentität:** Welcher Schlüssel erkennt denselben Shot zuverlässig über Hosts (Datei-Hash vs. Reel/Timecode vs. Host-Clip-ID), auch nach Umkopieren oder Transcodieren?
5. **Shot-Grenzen:** Wer bestimmt sie für die Shot-Normierung? Hostmetadaten, Schnittliste (EDL/AAF) oder Schnitterkennung im Editor?
6. **Toleranzen:** Sind die Werte aus §7.2 für Coloristen ausreichend streng, vor allem in dunklen Bereichen nach späteren Kontrasterhöhungen? Kalibrierung in Phase 2.
7. **Echte Szenenlinearität:** Wie viel ist Nebel/Relight auf display-bezogenem SDR-Material wert? Wird für Version 1 ein Szenenraum-Eingang (Log/ACES) Pflicht für räumliche Knoten?
8. **Relight-Physik:** Reicht die Albedo-Heuristik? Sind Screen-Space-Schatten aus der Tiefe sinnvoll oder zu artefaktanfällig? Teilweise beantwortet: Relight hat einen optionalen Hautschutz über den Farbschlüssel des Looks (§5.3.3), die Spitzlichtbegrenzung ist `preserveHighlights`. Offen bleibt, ob ein Farbschlüssel genügt oder eine Hautmaske des Hosts (`mask.input`) der empfohlene Weg ist.
9. **Metrische Tiefe:** Lohnt sich `lens.dof` im Modus `physical` ohne lizenzklares metrisches Videomodell? Die Lizenz der metrischen Video-Depth-Anything-Varianten ist ungeklärt; Depth Pro hat eine Apple-eigene Lizenz.
10. **Modellverteilung:** Wie werden Modellgewichte ausgeliefert und aktualisiert (im DMG/PKG, separater Download mit Hash, Größe), und wie verhält sich das mit Apache-2.0-Hinweispflichten?
11. **Signaturen:** Braucht Version 1 eine Herkunftssignatur (z. B. Ed25519) für Studios, die nur geprüfte Looks zulassen? Wer verwaltet die Schlüssel?
12. **Versionsbindung von `color.look`:** Wird `applyLook` absehbar geändert (z. B. für HDR oder Szenenlinearität)? Dann sollte die Formel vor Phase 2 eingefroren und als `color.look@1` dokumentiert werden.
13. **Masken aus dem Host:** Sollen Resolve-Power-Windows oder Magic Mask über `mask.input` eingebunden werden, und mit welchem Kanal- und Farbraumvertrag?
14. **Exportziele:** Welche Priorität haben CLF-, DCTL- und Gizmo-Exporte gegenüber dem eigenen OFX-Effekt? DCTL-Texturzugriff für Tiefe in Resolve ist nicht geprüft.
15. **Lizenz der Spezifikation:** Bleibt das Format proprietär oder wird die Spezifikation offen veröffentlicht, als Voraussetzung für Verbreitung über Buckswood hinaus?
16. **Korn und Ausgaberaum:** Gehört Filmkorn vor den Grade (wie im Negativ, §5.6) oder ans Ende der Kette, damit es nach Kontrast und Kompression sichtbar bleibt? Soll `film.grain` eine Option für display-bezogenes Korn bekommen (dann eine neue Knotenversion)?
17. **Korn bei Proxy-Renders:** Das Muster ist an Bildbreiten gebunden; im Proxy sinkt deshalb die Streuung pro Pixel. Ist das gewünscht (Verhalten eines verkleinerten Scans), oder soll ein Host im Proxy das Erscheinungsbild der Vollauflösung nachbilden?
18. **Herstellerfeld des Tageszeit-Schalters:** Reicht `x-buckswood-tod` (§5.7) als Rücknahmeinformation, oder sollte das Format ein allgemeines Feld für „vom Werkzeug erzeugt/angepasst“ bekommen, damit auch andere Hosts solche Knoten erkennen?
