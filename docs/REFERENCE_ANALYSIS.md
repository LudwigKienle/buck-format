# Referenzanalyse 2.0 (.buck-Editor)

Der Nutzer lädt **nur ein Referenzbild**. Der Editor misst daran Farbe, Lichtfarbe, Tageszeit, Himmel, Dunst, Tiefenschärfe,
Lichtrichtung und Lampen und schlägt daraus einen vollständigen `.buck`-Graphen für das geladene Ausgangsbild vor.

**Die Referenzanalyse ist eine Editor-Funktion, kein Teil des Dateiformats.** Eine `.buck`-Datei enthält danach nur gewöhnliche
Knoten (`color.cdl@1`, `light.relight@1`, `light.practicals@1`, `sky.replace@1`, `atmos.fog@1`, `lens.dof@1`, `color.lut3d@1`)
und die eingebettete LUT `luts/reference_64.cube`. Das Referenzbild selbst wird nie in die Datei geschrieben und verlässt den
Browser nicht. Alles läuft lokal und deterministisch: kein Netzwerkzugriff, keine generative KI, keine Zufallszahlen
(Unterabtastung über einen festen Hash). Gleiche Eingaben ergeben denselben Graphen.

Code: `src/buck/reference/` (Analyse, Graphaufbau, synthetische Testszenen), `src/buck/editor/ReferencePanel.tsx` (UI),
Einbindung in `src/buck/editor/BuckEditor.tsx`. Tests: `tests/buck-reference.test.ts`.

## Ablauf

1. **Referenz laden** – gleiche Ladefunktion wie das Ausgangsbild (`readImage`, längste Seite ≤ 1100 px), die Pixel werden im
   selben deklarierten Eingangsraum gelesen wie das Ausgangsbild.
2. **Tiefe der Referenz** – hat der Nutzer in den Hilfskanälen das gepinnte Modell (Depth Anything V2 Small) bereits laufen
   lassen, wird dieselbe ONNX-Datei wiederverwendet: `BuckEditor` merkt sich die dort gewählte Datei als `File`-Handle für die
   Sitzung (Capture-Listener auf dem Dateifeld; `AuxPanel` selbst hält die Gewichte nach dem Lauf nicht im Speicher). Die Datei
   wird erneut gelesen und im Worker gegen den SHA-256 des lokalen Registers geprüft. Ohne Modell: Bildheuristik
   (`heuristicDepth`), im UI gelb als „Behelf: Bildheuristik – keine echte Tiefenschätzung“ markiert.
   Normierung wie beim Ausgangsbild: `shot-percentile` 2 %/98 %.
3. **Analyse** auf einer Arbeitskopie (längste Seite 512 px, lineares Rec.709-Displaylicht) von Referenz *und* Ausgangsbild.
   Das Ausgangsbild wird mit derselben Methode gemessen, damit nur der Unterschied übertragen wird (z. B. Dunst, den das
   Ausgangsbild schon hat, wird nicht doppelt aufgetragen).
4. **Vorschläge** – je Aspekt: Wert, Konfidenz 0…1 (Chip: hoch ≥ 0,67, mittel ≥ 0,4, sonst niedrig), kurze Begründung,
   „übertragbar ja/nein“ mit Grund und ein Häkchen. Vorausgewählt ist ein Aspekt nur, wenn er übertragbar, ausreichend sicher
   und wirksam ist.
5. **Übernehmen** baut den Graphen in den Ebenen des Editors (`LEVELS` in chain.ts): Licht (Belichtung/Lichtfarbe als
   lineare CDL, Relight, Lampen) → Atmosphäre (Himmel, Dunst) → Optik (Tiefenschärfe) → Grade (3D-LUT zuletzt, per
   `insertByLevel`). Der Himmel läuft über den Tageszeit-Schalter (`applyTimeOfDay` aus prompt.ts): Der Schalter zeigt danach
   die erkannte Tageszeit, „Wie aufgenommen“ entfernt sie wieder. `tod-sky` bekommt die gemessenen Werte; von den gekoppelten
   Knoten des Schalters bleibt nur der Preset-Grade `tod-grade` – Belichtung, Licht, Lampen und Dunst kommen aus der Messung
   (oder wurden bewusst abgewählt), und die Anpassungen des Schalters an eigenen Knoten (Nebelluminanz, Lampenschwelle)
   werden zurückgenommen. Die Residual-LUT gleicht den Grade wie jeden anderen vorgeschalteten Knoten aus. Danach
   `ensureConversions` + `ensureInputs`. Name: „Referenz · <Dateiname>“. Farbmanagement des aktuellen Looks bleibt.

## Verfahren je Aspekt

### Farbe (3D-LUT)
Der bestehende Auto-LUT-Abgleich (`analyze` → `buildModel(reference, source, settings)` → `makeCube`, 64³, Stärke 1) in
`src/color` bleibt unverändert. Zwei Ergänzungen außerhalb von `src/color`:

- **Residual statt Doppelwirkung:** Die LUT wird zuletzt gerechnet – gegen eine verkleinerte Vorschau des Ausgangsbilds *durch
  alle übrigen gewählten Knoten* (mit der Tiefe des Editors). Belichtung, Himmel und Dunst wirken dadurch nicht doppelt.
- **Materialgewichtung:** `analyze` überspringt Pixel mit Alpha < 0,98. Pixel großer gesättigter Materialflächen werden mit
  der Wahrscheinlichkeit 1 − Gewicht (Gewicht bis hinunter auf 0,15) per festem Hash ausgeblendet – gewichtete Statistik, ohne
  `src/color` zu ändern.
- **Begrenzte Kontrastübertragung:** Der Median (Key) der Referenz wird übernommen, ihre Spreizung um den Median nur im
  Bereich ×0,75…×1,3 der Spreizung des Ausgangsbilds, die Form der Verteilung bleibt die des Ausgangsbilds. Kontrast hängt
  stark vom Bildinhalt ab (eine Wüste hat kaum Schatten); ohne diese Grenze wurde eine schattige Terrasse flau.
  Farbmittelwert und -kovarianz bleiben die der Referenz (von `buildModel` selbst begrenzt).

Angezeigt wird zusätzlich die grobe LookSpec-Tendenz: Key (Blenden), Kontrast- und Sättigungsverhältnis.
Konfidenz 0,85, gesenkt bei geringem Tonwertumfang oder beschnittenen Lichtern.

### Licht- vs. Materialfarbe
Heuristische Trennung, keine Intrinsic-Image-Zerlegung. Drei klassische Farbkonstanz-Schätzungen auf den Nicht-Himmel-Pixeln
ohne Beschnitt, als geometrisches Mittel kombiniert:

- **Gray-Edge** 1. Ordnung, Minkowski-Norm p = 6, Gauß σ = 1 px (van de Weijer, Gevers, Gijsenij 2007): Die mittlere
  Kantenfarbe ist unter neutralem Licht unbunt. Pixel am Rand zum Himmel/Beschnitt bleiben außen vor (Mischkanten).
- **White-Patch** auf hellen, wenig gesättigten Flächen (oberste 5 % Luminanz unter den Pixeln nahe der aktuellen Lichtfarbe).
- **Shades-of-Gray** p = 4 (Finlayson & Trezzi 2004) der großskaligen Beleuchtung (maskierte Gauß-Unschärfe σ = 8 % der
  Bildbreite, Retinex-Gedanke: Land & McCann 1971; Jobson et al. 1997).

**Materialflächen:** Sättigung *nach* Division durch die aktuelle Lichtschätzung; was bunt bleibt und eine große Fläche
bedeckt (Gauß-Flächenanteil, σ = 4 % Breite), gilt als Materialfarbe und wird heruntergewichtet; drei Iterationen. Ergebnis:
Lichtfarbe in Kelvin und Duv (Ohno 2014, CIE 1960 uv, positiv = grünlich), über dieselbe Planck-Kurve (Kim et al.), die die
Knoten für `{"kelvin": K}` verwenden – ein gemessener Wert reproduziert also im Knoten seine eigene Farbart.
Übertragen als Weißabgleich: CDL-Slope = Referenzlicht / Ausgangslicht im linearen Arbeitsraum (luminanzneutral, je Kanal
0,4…2,5). Konfidenz aus der Übereinstimmung der drei Schätzungen (Winkel, 14° → 0) und dem Flächenanteil gültiger Pixel.

### Tageszeit & Belichtung
Merkmale: Himmelsluminanz, Wärme ln(R/B) am Horizont und im Zenit, Szenenhelligkeit (Median der Nicht-Himmel-Luminanz),
Wolkenstruktur, Sterne, Mond, Dunstmenge, Grün- bzw. Magentaanteil des Himmels. Klassifikation: nächster Prototyp unter den
`SKY_PRESETS` (Prototypen aus der Preset-Tabelle von `sky.replace@1` plus eine redaktionelle Szenenhelligkeit je Preset), mit
Regeln: Mond spricht für Nacht/Mondaufgang (Mondaufgang nur bei tiefem Mond), viele Sterne für die Sternen-Presets,
Polarlicht braucht Grün, Neon-Nacht Magenta, Sandsturm starken Dunst. In dunklen Himmeln zählt der Farbton weniger
(Rauschen, Grading). Konfidenz aus dem Abstand zum zweitnächsten Prototyp.

Belichtung: EV = log2(Median Referenz / Median Ausgangsbild) der Nicht-Himmel-Luminanz, −4…+1,5. Bei EV ≤ −0,7 wird wie in
`prompt.ts` eine Szenenbelichtung als `color.cdl@1` im linearen Raum vor Licht und Himmel gesetzt (Day-for-Night-Prinzip),
dazu eine gemessene Sättigung (√ des Chroma-Verhältnisses, 0,6…1; `prompt.ts` nutzt für Nacht 0,75). Hellere Referenzen
überlässt die Analyse der Tonwertkurve der LUT.

### Himmel
Himmelsregion: ungültige Tiefe (wenn ≥ 1 % der Fläche), sonst eine vom oberen Rand gewachsene Region aus glatten, fernen
Pixeln mit kleinen Farbsprüngen; eingeschlossene Löcher (Mond, Sterne, Wolkenreste) gehören dazu. Gemessen als Median je
Kanal (Sterne/Mond verschieben ihn nicht): Zenit (oberes Drittel), Horizont (unteres Viertel), Gradientenexponent aus der
Mitte, Wolkenanteil (Abweichung vom Zeilenprofil), Sterne (isolierte 3×3-Maxima in dunklem Himmel, kalibriert am
prozeduralen Himmel: 0,016 Sterne je Arbeitspixel bei `stars` = 1), Mond (hellste kompakte Scheibe ≥ 0,5 % Bildbreite).
Daraus `sky.replace@1` mit **gemessenen Farben** (Belichtung so, dass Zenit/Horizont ihre gemessene Luminanz haben); das Preset
dokumentiert nur die Kategorie und liefert die übrigen Vorgaben. Der Mond behält seine Höhe über dem Horizont und rückt
seitlich an die nächste Stelle, an der der Himmel des Ausgangsbilds ihn zeigen kann.

**Nicht übertragbar**, wenn das Ausgangsbild keinen Himmel hat. Mit Modell- oder geladener Tiefe entscheidet die Tiefe
(ungültige Werte); mit Behelfstiefe wird der Himmel im Bild gesucht und `skyDepth` auf deren Tiefenuntergrenze gesetzt –
dann sind die Kanten sichtbar unsauber, darum nicht vorausgewählt und Konfidenz × 0,6.

### Dunst
Dark-Channel-Prior (He, Sun, Tang, CVPR 2009 / TPAMI 2011): In dunstfreien Außenbildern ist das lokale Minimum über die
Farbkanäle ≈ 0, im dunstigen Bild ist der auf das Luftlicht A normierte Dark Channel ≈ 1 − t mit t = e^(−β·d). A nach He et
al. (hellstes Pixel unter den 0,1 % mit dem hellsten Dark Channel), aber nur unter Himmel und den fernsten 10 % der Tiefe
gesucht (sonst gewinnt eine sonnige Wand). Je Tiefenstufe (8 Stufen) der Median des normierten Dark Channels; abgezogen wird
der Grundpegel der Stufen näher als 0,3 (der Prior versagt auf luftlichtähnlichen Flächen wie hellem Sand – He et al. §6;
Dunst muss mit der Tiefe wachsen). Referenz minus Ausgangsbild ergibt die zusätzliche Deckkraft, angepasst (Gittersuche +
geschlossene Lösung) an das Modell von `atmos.fog@1`: Deckkraft(d) = maxOpacity·(1 − e^(−density·max(0, d − start))).
Farbe/Luminanz = Luftlicht. `skyProtect` 0, wenn der Referenzhimmel selbst Dunstfarbe hat (Sandsturm), sonst 0,3.

**Nicht übertragbar** („Szene zu flach für Dunst“), wenn Referenz oder Ausgangsbild zu wenig Tiefenumfang haben:
Interquartilsabstand der Tiefe < 0,15 oder weniger als 6 % nahe (< 0,3) bzw. ferne (> 0,6) Pixel, oder keine Tiefe.
Relative Tiefe ist je Shot normiert; beurteilt werden kann nur ihre Verteilung, nicht der absolute Abstand.

### Tiefenschärfe
Je Tiefenstufe das Verhältnis Feindetail/Mitteldetail |Y′ − G₁Y′| / |Y′ − G₄Y′| (Y′ = Y^(1/2.2)); es fällt, wenn feine
Strukturen fehlen, und hängt nicht vom Texturkontrast ab (Variante der Gradienten-/Laplace-Fokusmaße, vgl. Pertuz et al.
2013). Relativ zur schärfsten Stufe über eine Kalibrierkurve (an 1/f-Rauschen gemessen) in eine äquivalente Gauß-Unschärfe
umgerechnet; Referenz minus Ausgangsbild in Quadratur. Anpassung an die CoC-Form von `lens.dof@1` artistic (Fokus,
Fokusbereich, blurNear/blurFar, CoC-Durchmesser ≈ 4σ) mit kleinem Strafterm auf die Unschärfegröße. Vorgeschlagen nur bei
ausreichender Evidenz (Unschärfe ≥ ~1 Arbeitspixel und gute Anpassung). Wenig Textur → niedrige Konfidenz.

### Lichtrichtung
Ausgleichsrechnung auf Lambert-Schattierung: log Y ≈ c₀ + v·n mit Normalen aus der Referenztiefe (`normalsFromDepth`,
dieselbe Ableitung wie `normals-from-depth@1`). Beide Seiten werden mit derselben maskierten Gauß-Unschärfe (σ = 10 % Breite)
hochpassgefiltert – das entfernt den glatten Normalendrift, den die Ableitung auf einer Bodenebene in Perspektive erzeugt, und
großräumige Helligkeitsverläufe. L = v/|v| → `light.relight@1` (Azimut/Elevation), Farbe = geschätzte Lichtfarbe, Maske
Vorder-/Mittelgrund wie in `prompt.ts`, Stärke grob aus dem Schattierungskontrast (Referenz minus halbes Ausgangsbild).
Konfidenz aus R², Streuung der Normalen (kleinster Eigenwert), Split-Half-Stabilität und Tiefenquelle; **höchstens 0,65**
(„mittel“), weil abgeleitete Normalen systematisch falsch sein können, ohne dass R² oder der Split-Test es zeigen. Vorausgewählt
erst ab 0,5.

### Lampen
Erkennung wie `light.practicals@1` (`detectPracticals`: Helligkeitsschwelle, Kontrast zur Umgebung, Größenband) mit einer
bildabhängigen Schwelle (80 % des 99,7-%-Perzentils, 0,25…0,9), ohne Treffer im Himmel (Mond). Lichtfarbe aus dem Lichthof
um die meist weiß beschnittenen Kerne, Stärke aus Lichthof gegen weitere Umgebung. **Nicht übertragbar**, wenn die Referenz
keine Lampen zeigt oder das Ausgangsbild keine hellen, kompakten Quellen hat (Lichtpunkte lassen sich im Knoten von Hand
setzen). Die Schwelle im Graphen folgt der Szenenbelichtung davor (wie `prompt.ts`).

## Konfidenzlogik (Übersicht)

| Aspekt | steigt mit | sinkt mit |
|---|---|---|
| Farbe | – (fest 0,85) | geringem Tonwertumfang, Beschnitt |
| Lichtfarbe | Übereinstimmung der drei Schätzer, gültiger Fläche | Streuung > 14°, |Duv| > 0,03 |
| Tageszeit | Abstand zum zweitbesten Prototyp | fehlendem Himmel in der Referenz (× 0,6) |
| Himmel | Himmel aus Tiefe (0,85; aus dem Bild 0,65), Himmelsfläche ≥ 8 % | Behelfstiefe im Ausgangsbild (× 0,6) |
| Dunst | R² der Anpassung, Dunstmenge | Behelfstiefe (× 0,55), keiner Tiefe |
| Tiefenschärfe | texturierten Stufen, Evidenz | Behelfstiefe (× 0,55), wenig Textur |
| Lichtrichtung | R², Normalenstreuung, Split-Stabilität | Behelfstiefe (× 0,35); Deckel 0,65 |
| Lampen | Flächenanteil | Farbe weit neben der Planck-Kurve |

## Invarianz-Testset („Invarianz messen statt behaupten“)

`src/buck/reference/synthetic.ts` erzeugt deterministische Szenen (Boden mit Perspektivtiefe, Himmel mit unendlicher Tiefe,
Kugeln mit exakter Lambert-Schattierung, optional Berge und eine große rote Wand) in drei Inhalten (A, B, C) und den Looks
warm (3200 K, goldene Stunde), kalt (8000 K, bedeckt), Tag, Nacht (−3,2 EV), Dunst (echter `atmos.fog@1`) und Tiefenschärfe
(echter `lens.dof@1`). `tests/buck-reference.test.ts` prüft mit dokumentierten Toleranzen:

- **Gleicher Inhalt, anderer Look → unterscheidbar:** warm < 4200 K, kalt > 6200 K, Abstand > 100 Mired; Nacht wird als
  dunkle Tageszeit mit EV < −2 erkannt, Tag als klarer Tag ohne Belichtung; nur der Dunst-Look schlägt Nebel vor, nur der
  DOF-Look Unschärfe hinten (blurFar > 0,8 % Breite, Fokus vorn).
- **Anderer Inhalt, gleicher Look → ähnlich:** Lichtfarbe innerhalb **25 Mired**, gleiche Tageszeit (Nacht: gleiche
  Familie), Dunstdichte innerhalb **Faktor 2,5**, Lichtazimut innerhalb **40°** (gemessen: Abweichung bis ~25°, systematisch
  zu flach in der Elevation).
- **Rote Wand als Material:** Lichtfarbe verschiebt sich um weniger als **20 Mired** (gemessen ≤ ~8), Gray World um mehr als
  das Doppelte (gemessen 50–100 Mired).
- Übertragbarkeit (kein Himmel, flache Tiefe, keine Lampen), Graphaufbau (gültig nach `checkGraph`, LUT 64³ eingebettet,
  rendert ohne Überbrückung), begrenzte Kontrastübertragung, Mondplatzierung, Determinismus.

## Grenzen

- **Inhalt vs. Look:** Statistische Abgleiche (Tonwerte, Schärfeprofil) messen immer auch den Bildinhalt. Die Grenzen oben
  dämpfen das, beseitigen es nicht – Ergebnisse sind Vorschläge, keine Messungen des „Looks an sich“.
- **Relative Tiefe:** Dunst, Tiefenschärfe und Himmel beruhen auf normierter relativer Tiefe; absolute Entfernungen kennt die
  Analyse nicht. Mit Behelfstiefe sind diese Aspekte deutlich unsicherer und sichtbar gröber.
- **Dark-Channel-Prior** versagt auf luftlichtähnlichen Flächen und nachts; der Grundpegel-Abzug unterschätzt Dunst direkt vor
  der Kamera.
- **Lichtrichtung** aus abgeleiteten Normalen ist oft um 20–30° daneben (synthetisch gemessen), Schlagschatten und Glanz
  stören zusätzlich.
- **Tageszeit-Prototypen** sind redaktionell; graded Referenzen (z. B. graue Nachthimmel) liegen oft zwischen zwei Presets.
  Die Himmelsfarben werden deshalb gemessen, das Preset dient nur als Kategorie.
- **Lampen** werden nur übertragen, wenn das Ausgangsbild selbst helle, kompakte Quellen hat; Positionen werden nicht aus der
  Referenz kopiert.
- Szenenbelichtung über Mediane: Eine von einer Lampe hell beleuchtete Nachtreferenz ergibt eine hellere „Nacht“, als man
  erwartet.

## Quellen

- J. van de Weijer, T. Gevers, A. Gijsenij: *Edge-Based Color Constancy.* IEEE Transactions on Image Processing 16(9),
  2207–2214, 2007. doi:10.1109/TIP.2007.901808
- K. He, J. Sun, X. Tang: *Single Image Haze Removal Using Dark Channel Prior.* CVPR 2009; erweitert in IEEE TPAMI 33(12),
  2341–2353, 2011.
- G. D. Finlayson, E. Trezzi: *Shades of Gray and Colour Constancy.* Color and Imaging Conference, 2004.
- E. H. Land, J. J. McCann: *Lightness and Retinex Theory.* JOSA 61(1), 1971; D. J. Jobson, Z. Rahman, G. A. Woodell:
  *A Multiscale Retinex …*, IEEE TIP 6(7), 1997.
- Y. Ohno: *Practical Use and Calculation of CCT and Duv.* LEUKOS 10(1), 2014.
- S. Pertuz, D. Puig, M. A. Garcia: *Analysis of focus measure operators for shape-from-focus.* Pattern Recognition 46(5), 2013.
- Kim et al., Planck-Kurven-Spline (US 7024034; Kang et al. 2002) – wie in `src/buck/colorspace.ts`.
- Koschmieder/Beer–Lambert-Modell und CoC-Form: siehe `docs/BUCK_FORMAT.md` §5.3.1/§5.3.2.
