# Wysiwyl

*What You See Is What You Listen*

*[English version](README.md)*

Wysiwyl est une application desktop Tauri qui transforme une image en musique : chargez une image, convertissez-la en grille de pixels, puis laissez un ou plusieurs synthétiseurs lire cette grille pour produire des notes MIDI en temps réel — la couleur devient la hauteur, la luminosité devient le rythme.

## Fonctionnalités

### Image
- Chargement via une boîte de dialogue native ; aperçu avec bascule original/traité.
- Grille de pixels : nombre de colonnes (slider logarithmique, hauteur déduite du ratio d'aspect) ; réduire la grille rogne les zones.
- Réglages : luminosité, contraste, vibrance, postérisation, texture, clarté, simplification et auto-niveaux, plus le tramage Floyd–Steinberg (niveaux, diffusion, serpentin). Double-cliquez sur un curseur pour le réinitialiser.
- Rotation (par pas de 90°), recadrage (libre ou 1:1 / 4:3 / 3:2 / 16:9), rotation fine et perspective ; zoom/pan de l'aperçu à la molette et au glisser.
- Pendant qu'un synthé joue, les contrôles structurels (chargement, rotation, recadrage, transformation, grille) se verrouillent ; les réglages de valeurs restent modifiables et s'appliquent au pas suivant.
- **Fenêtre de projection** (second écran, plein écran) : superpose l'original et la grille traitée. Un effet de masquage perce la couche du dessus — *Drag* (une traînée s'estompant derrière chaque tête de lecture) ou *Frontline* (la ligne perpendiculaire) — avec longueur, fondu et teinte réglables. La bascule « Voir l'original » échange les deux couches. Les zones sont masquées par défaut et se cyclent avec un bouton (tous les synthés / visibles seulement / aucun).

### LFO
- Deux LFO (cyan, magenta) à 5 formes d'onde (sinus, triangle, dent de scie, carré, échantillon & maintien) et une fréquence réglée en glissant sur le graphe (en Hz ou en temps de métronome ; double-clic pour réinitialiser).
- Chaque LFO peut piloter n'importe quel réglage ajustable — les sept curseurs d'image, plus le décalage de teinte et le volume de canal de chaque synthé — avec sa propre amplitude et sa phase (100 % = opposition de phase). Un LFO peut piloter plusieurs réglages. Une pastille à côté d'un curseur l'assigne ; un pouce fantôme et la valeur suivent la modulation.

### Synthétiseurs
Créez autant de synthétiseurs indépendants que vous le souhaitez, chacun lisant la grille de façon autonome et envoyant du MIDI en temps réel, cadencés par un métronome commun.

- **Modes** — Monophonique (teinte → une note, avec un curseur de décalage de teinte 0–360°) ou Polyphonique (R/V/B lus indépendamment → un accord de 1 à 3 notes ; les canaux se désactivent, leur survol affiche leur carte d'intensité).
- **Zones** — sélectionnez les pixels joués par rectangle, lasso ou baguette magique (adjacente/non adjacente, tolérance réglable). Stockées en composantes connexes exactes ; un clic/glisser depuis un pixel libre ajoute, depuis un pixel sélectionné retire ; éditables pendant la lecture. Survolez un pixel pour prévisualiser sa note.
- **Silences** — Shift bascule un silence manuel sur les pixels sélectionnés (toujours parcourus, muets), Alt+Shift le retire. Un **motif de silences** de 16 pas peut être appliqué en cliquant une zone (répétition optionnelle).
- **Lecture** — sens (gauche→droite, droite→gauche, haut→bas, bas→haut, deux spirales) ; un bouton « tri » fusionne les zones en un balayage unique par position absolue.
- **Transport** — lecture/arrêt, rembobinage, pas en avant ; boucle, aller-retour ou lecture unique ; ratio de tempo par synthé (1/2 … 3/2 du métronome).
- **Longueurs de note** — double croche, croche, noire, blanche, ronde : la luminosité du pixel choisit sa durée ; inversion, ternaire (triolets), articulation soutenue/pizzicato et legato disponibles.
- **Timing** — quantize sur le tempo maître (période de recalage 1–8 temps) et chance (probabilité de jeu par pas).
- **Accent** — niveaux de vélocité par temps (off / faible / normal / fort), multipliés par des valeurs globales du fichier de config.
- **Plage de notes** — filtres basses (21–47), médiums (48–71), aigus (72–108) cumulables (bornes configurables), un par voix en polyphonique ; la note est recalée dans la plage autorisée.
- **Gamme** — accroche les notes à l'une des 14 gammes, avec une tonique choisissable (Chromatic = aucune quantification).
- **Vélocité** — fenêtre min–max, en mode relatif (recalage) ou clamp.
- **MIDI** — port, canal (1–16, premier libre par défaut), volume de canal (CC 7) avec mute, et choix de banque/programme.
- **Organisation** — couleur d'identification, bascule de surlignage des zones, panneau d'infos (pixel, note, plages), renommage (double-clic), réordonnancement au glisser, copie des paramètres/zones d'un autre synthé, suppression sécurisée (double clic), enregistrement comme gabarit par défaut.
- **Aide contextuelle** — un bouton dans le pied de page active les explications au survol de n'importe quel contrôle.
- **Liste** — tout jouer / tout arrêter et un bouton panic (coupe toutes les notes) ; le métronome démarre et s'arrête de lui-même.

### Sortie MIDI
- Le premier port disponible est connecté au démarrage ; chaque synthé peut viser son propre port (ouvert paresseusement).
- Messages Note On/Off en temps réel avec extinction propre ; le moteur bat à 12 wakes par temps, donc les longueurs de note restent précises.

### Utiliser Wysiwyl avec un DAW
- **Port virtuel** « Wysiwyl » (sortie) : apparaît comme une entrée MIDI dans le DAW pour piloter un instrument logiciel. Windows n'a pas de ports virtuels — utilisez loopMIDI.
- **Synchro de tempo** : l'application expose aussi un port d'entrée virtuel ; dirigez-y le MIDI clock du DAW et le métronome suit le tempo du projet (badge « Sync DAW », contrôles désactivés, alignement sur les doubles croches). Ableton Live sur macOS ignore les ports virtuels : utilisez le bus IAC.
- **Source d'horloge** (config `clock_mode`) : *Internal* (tempo propre uniquement), *Auto* (défaut, suit toute horloge entrante), *Source…* (seulement l'entrée choisie), *Master* (diffuse sa propre horloge 24 ppqn sur toutes les sorties pendant la lecture).
- Le transport reste toujours dans Wysiwyl ; l'horloge ne porte que le tempo (et, en mode maître, l'état de lecture).

### Sessions de travail
- Sauvegarde/chargement d'un fichier `.wysiwyl` autoportant : image originale (base64 PNG), réglages, LFO et associations, métronome, et chaque synthé avec sa configuration complète.
- Format version 3 (zones en RLE) ; les fichiers plus anciens sont refusés avec un message clair. L'état de lecture n'est pas restauré. Fermer avec des modifications non enregistrées propose de sauvegarder.

### Configuration globale
Un fichier JSON (ouvert via le bouton engrenage) regroupe les options globales, appliquées au démarrage ; une fois ouvert il est surveillé et se recharge à chaud. Clés :

- `max_image_size` — plus grand côté des images importées (0 = plafonné à 8192).
- `default_bpm` — tempo de démarrage.
- `clock_mode` / `clock_source` — source d'horloge et son port d'entrée.
- `time_signature` — cadre de la grille d'accent (« 4/4 », « 7/8 »… ou tout « n/d » : n 1–16, d 1/2/4/8/16).
- `accent_levels` — multiplicateurs de vélocité des quatre niveaux d'accent.
- `note_range_bounds` — bornes basses/hautes des filtres basses/médiums/aigus.
- `synth_colors` — palette du sélecteur de couleur des synthés.
- `enabled_scales` — gammes proposées dans les sélecteurs de gamme.
- `default_synth` — gabarit appliqué aux nouveaux synthés.
- `wheel_trackpad_threshold` — sensibilité de défilement des champs de valeur.
- `pizzicato_gate_ms` — durée minimale de note en mode pizzicato.
- `undo_depth` — profondeur de l'historique d'annulation des zones/silences.

### Raccourcis clavier
Un bouton du pied de page ouvre la liste complète. Principaux : Espace (tout jouer/arrêter), Shift+Espace (panic), 1–8 (déployer un synthé), Ctrl/Cmd+1–8 (lecture/arrêt), Alt+1–8 (mute), Ctrl/Cmd+S / O (sauver / ouvrir), Ctrl/Cmd+Z / Shift+Z (annuler / rétablir), Ctrl/Cmd+M (projection), Échap (annuler), Entrée (appliquer recadrage/transformation).

### Mises à jour automatiques
- Vérification silencieuse au démarrage et manuelle depuis le pied de page ; le bouton reçoit une pastille et le titre affiche la nouvelle version.
- « Installer et redémarrer » télécharge le paquet signé, le vérifie par rapport à la clé publique minisign de l'app, l'installe et relance. Seules les releases stables publiées sont suivies.
- **Configuration initiale** — `cargo tauri signer generate -w ~/.tauri/wysiwyl.key`, placez la clé publique dans `tauri.conf.json` (`plugins.updater.pubkey`) et la clé privée + son mot de passe dans les secrets CI `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Les builds macOS sont signés en ad-hoc (`signingIdentity: "-"`), donc Gatekeeper demande toujours au premier lancement.

## Stack technique
- **Tauri 2** (application desktop + IPC front/back), **Rust 2021** (traitement d'image, état, MIDI temps réel), **HTML/SCSS/JS vanilla** (sans framework ni bundler).
- Crates : `tauri`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-updater`, `image`, `midir`, `crossbeam-channel`, `serde` / `serde_json`, `base64`.

## Conventions frontend
- HTML/SCSS/JS pur : classes utilitaires (`_utilities.scss`, chargées en dernier) + classes de composants (un fichier par zone) + classes d'état à l'exécution (`.hidden`, `.active`, `.locked`…).
- Les `id` ne sont que des hooks `querySelector` — le CSS ne cible jamais un id ; les éléments répétés utilisent des classes et `data-synth-id`.
- Couleurs sémantiques : bleu = actif, rouge = lecture / confirmation destructive, vert = confirmation transitoire.
- `styles.scss` est le point d'entrée ; son ordre de `@use` est l'ordre de la cascade. Le markup dynamique vit dans `src/templates/*.html`, chargé par `js/core/templates.js` et cloné par `main.js`.
- Le CSS compilé est commité : après une modification du SCSS, lancez `sass scss/styles.scss:css/styles.css scss/mirror.scss:css/mirror.css` depuis `src/` (Node.js non requis).

## Installation
- [Rust](https://www.rust-lang.org/tools/install) avec Cargo, les dépendances système de Tauri, et le CLI (`cargo install tauri-cli`). Node.js n'est pas requis.

## Utilisation
```bash
cargo tauri dev     # développement
cargo tauri build   # version distribuable
npm test            # tests JS — cargo test pour les tests Rust
```
Dans l'application : chargez une image et réglez la grille et les ajustements ; ajoutez des synthétiseurs et choisissez un port, un canal et une couleur ; tracez des zones ; appuyez sur Play (ou « tout jouer ») ; sauvegardez la session dans un fichier `.wysiwyl`.

## Structure du projet
```text
wysiwyl/
├── LICENSE
├── README.md / README.fr.md
├── package.json
├── src/
│   ├── index.html          # fenêtre principale
│   ├── viewer.html         # fenêtre de projection
│   ├── assets/  fonts/  i18n/
│   ├── css/                # styles compilés (+ .min)
│   ├── scss/               # _variables, _mixins, _fonts, _reset, _utilities, components/
│   ├── templates/          # carte / onglet / plage de notes de synthé
│   └── js/
│       ├── main.js
│       └── audio/  core/  image/  mirror/  session/  synth/
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs  lib.rs  state.rs  error.rs
        ├── config.rs  session.rs  image_processing.rs
        ├── synth.rs  metronome.rs  midi.rs  updater.rs
        └── fsutil.rs  gate.rs  locks.rs  zone.rs
```

Le backend expose des commandes Tauri pour charger et ajuster les images, gérer les synthétiseurs (zones, lecture, MIDI, mode, tempo, longueurs de note, plages, gammes…), piloter le métronome, persister la configuration et les sessions, et vérifier/installer les mises à jour.

## Licence
GNU GPL v3 — libre d'utilisation, de modification et de redistribution, à condition que toute œuvre dérivée soit également publiée sous GPLv3 avec ses sources. Voir le fichier [LICENSE](LICENSE).
