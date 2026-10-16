# Wysiwyl

*What You See Is What You Listen*

*[English version](README.md)*

Wysiwyl est une application desktop Tauri qui transforme une image en musique. Chargez une image, convertissez-la en grille de pixels, puis laissez un ou plusieurs synthétiseurs lire cette grille pour générer des notes MIDI en temps réel — transformant ainsi couleurs et luminosité en son.

## Fonctionnalités principales

### Traitement d'image

- Chargement d'une image via une boîte de dialogue native.
- Aperçu de l'image originale et de l'image traitée, avec un bouton pour basculer entre les deux.
- Redimensionnement en grille de pixels, où chaque cellule devient une étape de la séquence.
- Ajustement du nombre de colonnes via un slider à échelle logarithmique (la hauteur est déduite automatiquement pour préserver le ratio d'aspect).
- Ajustements de saturation, contraste, luminosité et postérisation (réduction du nombre de niveaux de couleur/luminosité).
- Réinitialisation de tous les paramètres de traitement.
- Pendant qu'un synthétiseur joue, les contrôles structurels d'image (chargement, rotation, recadrage, transformation, taille de grille) sont automatiquement verrouillés afin de garder la grille de pixels stable. Les ajustements de valeurs (saturation, contraste, luminosité, postérisation) restent modifiables : leur effet est appliqué en direct à la lecture, au pas de métronome suivant (le bouton « Voir l'original » reste également disponible).

### Synthétiseurs

Vous pouvez créer autant de synthétiseurs indépendants que vous le souhaitez, chacun lisant la grille de pixels de façon autonome et envoyant des notes MIDI en temps réel, cadencés par un métronome commun (tempo en BPM). Chaque synthétiseur peut jouer à sa propre fraction du tempo principal, si bien que plusieurs synthés peuvent se désynchroniser et créer des polyrythmies.

- **Deux modes de traduction pixel → note, interchangeables pour chaque synthétiseur :**
  - **Monophonique** — la teinte du pixel (cercle chromatique TSL/HSL) détermine une note unique. Un curseur de décalage de teinte (0–360°) permet de faire tourner le cercle chromatique pour ajuster la tonalité dominante du morceau.
  - **Polyphonique** — chaque canal de couleur (Rouge, Vert, Bleu) est lu indépendamment et traduit en sa propre note, formant un accord de 1 à 3 notes. Chaque canal peut être activé ou désactivé individuellement. Survoler les boutons R/V/B affiche la carte d'intensité du canal correspondant directement sur l'image, pour vous aider à choisir les canaux à utiliser.
- **Zones rectangulaires** — sélectionnez les pixels que chaque synthétiseur doit jouer en traçant des rectangles ou des lassos à main levée, ou par un clic de baguette magique, directement sur l'image. La baguette magique englobe tous les pixels connexes au pixel cliqué dont la couleur reste dans la tolérance choisie, avec la même sémantique positionnelle que le rectangle : un clic sur un pixel libre ajoute la région englobée — fusionnant avec toute zone qu'elle touche — tandis qu'un clic sur un pixel sélectionné retire les pixels englobés. Tous les pixels sont sélectionnés par défaut ; un rectangle tracé depuis un pixel libre ajoute une zone, tandis qu'un rectangle tracé depuis un pixel déjà sélectionné retire ces pixels — un simple clic sélectionne ou désélectionne un pixel isolé. La ligne affiche également le nombre total de pixels sélectionnés. Les zones peuvent être modifiées pendant la lecture du synthé : la tête de lecture conserve le pixel qu'elle joue (elle est recalée dans la nouvelle sélection), et la zone sous la tête de lecture est verrouillée contre l'effacement — un tracé qui la touche est annulé. Vider les zones arrête toujours proprement le synthé.
- **Silences manuels** — maintenez Alt (Option) en utilisant les outils de sélection rectangle, lasso ou baguette magique pour ajouter ou retirer des silences parmi les pixels sélectionnés : un pixel silencieux reste parcouru par la tête de lecture, il ne sonne simplement pas. Un rectangle tracé sur des silences existants les retire, sinon il met en silence les pixels sélectionnés qu'il couvre ; le lasso bascule chaque pixel sélectionné englobé, et la baguette magique suit la même règle positionnelle — un clic sur un pixel joué met en silence les pixels sélectionnés englobés, un clic sur un pixel silencieux les fait rejouer. Les pixels silenciés reçoivent un voile et un glyphe de silence, et vivent toujours au sein de la sélection : désélectionner un pixel supprime son silence.
- **Tempo par synthé** — chaque synthétiseur peut jouer à une fraction du tempo du métronome commun (3/2, 4/3, 5/4, 1/1, 3/4, 2/3 ou 1/2 du BPM global), permettant aux synthés de se désynchroniser pour dynamiser la musique.
- **Nom personnalisé** — double-cliquez sur le titre d'un synthétiseur pour le renommer ; le nom est conservé dans les sessions.
- **Port de sortie MIDI par synthétiseur** — chaque synthé peut envoyer ses notes vers une interface MIDI différente. Les connexions sont ouvertes paresseusement à la première utilisation, et le premier port disponible est connecté automatiquement au démarrage.
- **Sens de lecture** — un bouton cyclique sélectionne l'ordre de lecture de la séquence de pixels : gauche → droite, droite → gauche, haut → bas ou bas → haut. Un bouton « tri » change le rapport des zones à cet ordre : inactif, chaque zone est lue intégralement, l'une après l'autre, dans l'ordre où elles ont été dessinées ; actif, les pixels de toutes les zones sont fusionnés et lus selon leur position absolue dans l'image — un unique balayage continu. La tête de lecture conserve son pixel lors du basculement.
- **Lecture en boucle, aller-retour ou ponctuelle** — un synthétiseur peut boucler indéfiniment sur ses zones, rebondir entre les bornes de la séquence (aller-retour), ou lire la séquence une seule fois puis s'arrêter. Boucle et aller-retour sont mutuellement exclusifs et peuvent être tous deux inactifs.
- **Longueurs de note** — des boutons (double croche, croche, noire, blanche, ronde) font correspondre la luminosité du pixel à une durée parmi les longueurs activées (les niveaux de luminosité 0–127 sont découpés en autant de bandes égales). Chaque pixel est joué pendant exactement la durée de sa note : le contraste de luminosité de l'image se traduit ainsi directement en rythme. Un bouton inverse le sens luminosité → longueur (sombre = long au lieu de clair = long) ; un bouton « 3 » bascule toute la palette en division ternaire (triolets : 3 dans le temps de 2, chaque longueur multipliée par 2/3) ; la noire reste toujours active.
- **Accent par mesure** — une grille d'accent, un pas par temps de la signature rythmique partagée, module la vélocité de chaque pixel selon le niveau du temps sur lequel il démarre, en plus de sa saturation : on peut appuyer le temps fort et adoucir les temps faibles. Quatre niveaux discrets (off / fort / normal / faible) se cyclent au clic ; le multiplicateur de vélocité de chaque niveau est global et éditable à la main dans le fichier de config. L'accent est désactivé par défaut et la mesure est partagée par tous les synthés, comptée depuis le début de la lecture (elle suit le Start du DAW en mode synchro).
- **Filtres de plage MIDI** — les boutons basses (21–47), médiums (48–71) et aigus (72–108) restreignent les notes qu'un synthétiseur peut jouer. Les filtres se cumulent pour étendre la plage autorisée ; aucun bouton actif = plage complète 0–127. La note brute dérivée du pixel est recalée proportionnellement dans la plage autorisée : la hauteur monte graduellement et en continu de la borne basse à la borne haute à mesure que la teinte (ou la valeur du canal) augmente. Le mode monophonique possède un filtre unique ; chaque voix R/V/B du mode polyphonique possède le sien.
- **Contrôles de lecture** — lecture/arrêt, rembobinage (replace la tête de lecture au début de la séquence) et pas en avant (avance manuellement d'un pixel pendant une pause, en le jouant sur sa longueur de note).
- **Vélocité minimum** — définit le plancher de la plage de vélocité ; la saturation du pixel est transposée entre ce plancher et la vélocité maximale (127). Les couleurs vives sont jouées avec une attaque plus forte, les zones achromatiques plus délicatement.
- **Choix du canal MIDI** par synthétiseur (16 canaux disponibles), verrouillé pendant la lecture. Un nouveau synthétiseur reçoit le premier canal libre (1–16) non utilisé par le stack, ou le canal 1 si tous sont pris.
- **Attribution d'une couleur** à chaque synthétiseur (via un sélecteur de couleurs prédéfinies), utilisée pour surligner ses zones et sa position de lecture courante directement sur l'image.
- **Bascule de visibilité** du surlignage des zones, automatiquement masqué pendant la lecture pour n'afficher que le curseur de lecture courant.
- **Affichage compact** — un bouton sur chaque synthétiseur le réduit au strict minimum : seuls les contrôles de lecture (tempo, sens de lecture, boucle, aller-retour, rembobinage, lecture/pause, pas en avant) restent visibles, accompagnés du port MIDI, du canal et du titre. Recliquez pour retrouver tous les réglages.
- **Suppression sécurisée** — supprimer un synthétiseur demande une confirmation : le premier clic arme le bouton (rouge) pendant 3 secondes, et seul un second clic dans cette fenêtre supprime réellement le synthé ; passé ce délai, le bouton reprend son état normal.
- **Aide contextuelle** — un bouton d'aide dans le pied de page active un mode d'aide au survol : survoler n'importe quel contrôle de l'interface ouvre une fenêtre d'explication détaillée à la place de l'info-bulle native, pour que les nouveaux utilisateurs découvrent chaque réglage sans fouiller dans ce README. Recliquez ou appuyez sur Échap pour quitter le mode.
- Lecture/arrêt individuel par synthétiseur, ainsi qu'un bouton « tout jouer / tout arrêter » pour l'ensemble de la liste.
- Le métronome commun démarre automatiquement dès qu'un synthétiseur commence à jouer, et s'arrête automatiquement une fois tous les synthétiseurs inactifs.

### Sortie MIDI

- Connexion automatique au premier port de sortie MIDI disponible au démarrage ; chaque synthétiseur peut être routé vers son propre port, les connexions étant ouvertes paresseusement à la première utilisation.
- Messages Note On / Note Off en temps réel : chaque pixel est joué comme une note possédant sa propre durée, avec extinction propre des notes à l'arrêt d'un synthétiseur ou lors d'un changement de mode. Le moteur bat au quart de temps afin que croches et doubles croches restent précises.

### Utiliser Wysiwyl avec un DAW

Wysiwyl expose tout ce dont un DAW a besoin, sans matériel requis (macOS et Linux) :

- **Port MIDI virtuel** — l'application crée au démarrage son propre port de sortie virtuel, « Wysiwyl », affiché en tête du menu des ports de chaque synthétiseur. Il apparaît dans votre DAW comme une entrée MIDI : sélectionnez-le comme source d'une piste instrument, et Wysiwyl pilote l'instrument logiciel de cette piste. Un utilisateur sans synthé physique peut donc composer avec Wysiwyl et entendre le résultat via le DAW.
- **Synchro de tempo (MIDI clock)** — l'application crée également un port d'*entrée* virtuel, lui aussi nommé « Wysiwyl ». Dirigez-y la sortie MIDI clock de votre DAW (Ableton Live : Préférences → Link/Tempo/MIDI → sortie de synchro MIDI ; Bitwig, Reaper, Logic : destination MIDI clock/sync) et le métronome suit automatiquement le tempo du projet : un badge « Synchro DAW » apparaît, les contrôles de tempo sont désactivés tant que l'horloge coule, et les pas de lecture s'alignent sur la grille de doubles croches du projet. Le tempo est appris depuis l'horloge à 24 ppqn et lissé ; un message Start/Continue réaligne la grille sur les temps du projet. Quand le DAW cesse d'envoyer l'horloge, le métronome continue au dernier tempo synchronisé et les contrôles sont relibérés.
- **Ableton Live sur macOS** — Live ne liste pas les ports MIDI créés par d'autres applications, dans aucun sens. Pour travailler avec Live, activez le bus IAC (Configuration Audio MIDI → double-clic sur « Pilote IAC » → « L'appareil est en ligne ») : le bus IAC apparaît dans Wysiwyl comme un port de sortie ordinaire pour les notes, et le DAW route son MIDI clock vers ce même bus pour la synchro de tempo.
- **Windows** — le backend WinMM n'a pas de ports virtuels : utilisez un bus loopMIDI, à la fois pour les notes (créez un bus, il apparaît comme port de sortie dans Wysiwyl et comme entrée MIDI dans le DAW) et pour l'horloge (routez le MIDI clock du DAW vers ce bus ; Wysiwyl écoute tous les ports d'entrée).
- Démarrer et arrêter la lecture des synthétiseurs se fait toujours depuis Wysiwyl : le DAW est le maître du tempo, pas celui du transport.

### Sessions de travail

- **Sauvegarde de l'état complet** dans un unique fichier `.wysiwyl` autoportant (boîte de dialogue d'enregistrement native) : l'image originale (embarquée en base64 PNG), les réglages de traitement d'image, le tempo du métronome, et chaque synthétiseur avec sa configuration complète (nom, couleur, zones, tempo, mode, longueurs de note, plages MIDI, seuils, vélocité, canal et port MIDI, sens de lecture, lecture triée, boucle/aller-retour).
- **Réouverture d'une session** via une boîte de dialogue native : l'image est re-dérivée de l'originale avec les réglages stockés, et tous les synthétiseurs sont recréés exactement tels qu'ils ont été laissés. L'état de lecture (positions des têtes de lecture, notes en cours) n'est volontairement pas restauré : tout repart du début.

### Configuration globale

Un fichier de configuration JSON (ouvrable via le bouton engrenage des paramètres de l'application) regroupe les options globales, éditables à la main dans un éditeur de texte et appliquées au prochain démarrage. Une fois le fichier ouvert depuis ce bouton, il est aussi surveillé : sauvegarder vos modifications les recharge à chaud (les écritures de l'application sont ignorées, et le tempo live reste celui réglé dans l'interface, donc `default_bpm` ne s'applique qu'au démarrage). Un bref flash vert sur le bouton engrenage confirme le rechargement.

- **`max_image_size`** — plus grand côté autorisé pour les images importées ; les images plus grandes sont redimensionnées à l'import (0 = illimitée).
- **`default_bpm`** — tempo du métronome utilisé au démarrage.
- **`time_signature`** — signature rythmique du métronome, cadre de la grille d'accent partagée par tous les synthés : `"4/4"`, `"3/4"`, `"2/4"`, `"6/8"`, `"5/4"`, `"7/8"`, `"9/8"`, `"12/8"`, `"5/8"` ou `"2/2"`. Toute autre combinaison `"n/d"` est aussi acceptée (numérateur 1–16, dénominateur 1, 2, 4, 8 ou 16). Réglée depuis le bloc métronome de l'interface, où le numérateur et le dénominateur sont saisis directement.
- **`accent_levels`** — multiplicateurs de vélocité (en pourcent) des quatre niveaux d'accent (`off`, `weak`, `normal`, `strong`) : la vélocité issue de la saturation d'un pixel est multipliée par le pourcentage du niveau de son temps, puis bornée à 1–127. `100` = neutre. Les motifs par synthé s'éditent sur les cartes ; ces valeurs sont la correspondance globale.
- **`default_synth`** — gabarit appliqué à chaque nouveau synthétiseur ; n'importe quel synthé existant peut être enregistré comme gabarit via son bouton marque-page (« Utiliser ce synthé comme modèle par défaut »).
- **`pizzicato_gate_ms`** — durée minimale (ms) d'une note en articulation pizzicato (`note_sustain = false`) : le Note Off est différé d'autant au lieu d'être envoyé dans le même paquet que le Note On, pour que les synthés logiciels dont l'enveloppe a besoin de temps pour monter (Vital, etc.) produisent un vrai pluck. `0` restaure le comportement historique (Note Off immédiat, le release de l'instrument façonnant la queue) ; défaut `40`, borné à 0–1000. La durée effective est plafonnée par l'articulation suivante.
- **`undo_depth`** — profondeur de l'historique d'annulation/rétablissement des zones et silences (nombre de pas conservés) ; défaut `25`, borné à 1–500. Annuler/rétablir via Cmd/Ctrl+Z et Cmd/Ctrl+Shift+Z.

### Mises à jour automatiques

Wysiwyl vérifie les releases GitHub à la recherche d'une version **stable** plus récente et peut se mettre à jour sur place :

- **Vérification** — une vérification silencieuse a lieu au démarrage, et une vérification manuelle est accessible via le bouton de mise à jour dans le pied de page. Quand une version plus récente existe, le bouton reçoit une pastille et la barre de titre l'affiche juste après le numéro de version (ex. `Wysiwyl 2.8.0 — Mise à jour 2.9.0`).
- **Installation** — le bouton ouvre une boîte de dialogue avec les notes de version et une action « Installer et redémarrer » : le paquet signé est téléchargé (avec une barre de progression), vérifié par rapport à la clé publique de l'app, installé, puis l'application redémarre.
- **Canal** — seules les releases publiées non préliminaires sont suivies (`releases/latest`) ; les versions beta/rc sont ignorées. La CI conserve les releases en brouillon : une release doit donc être publiée manuellement avant que l'updater ne la voie.
- **Intégrité** — le paquet téléchargé est vérifié avec la clé minisign propre à l'app (clé privée dans le secret CI `TAURI_SIGNING_PRIVATE_KEY`, clé publique dans `tauri.conf.json`). C'est indépendant de la signature Apple (optionnelle).
- **macOS** — les builds sont signés en ad-hoc (`signingIdentity: "-"`) ; Gatekeeper demande toujours à l'utilisateur d'autoriser l'app au premier lancement (et après une mise à jour). Une notarisation complète nécessiterait un compte Apple Developer payant.

Les artefacts d'updater (et le manifeste `latest.json` que `tauri-action` joint à chaque release) sont produits grâce à `bundle.createUpdaterArtifacts`.

**Configuration initiale** — générez la paire de clés de l'updater avec `cargo tauri signer generate -w ~/.tauri/wysiwyl.key`, placez la clé publique dans `tauri.conf.json` (`plugins.updater.pubkey`, en remplaçant la valeur de remplacement) et la clé privée ainsi que son mot de passe dans les secrets GitHub `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Conservez la clé privée précieusement : la perdre signifie qu'aucune application déjà installée ne pourra plus jamais être mise à jour. Un `cargo tauri build` local nécessite alors que `TAURI_SIGNING_PRIVATE_KEY` soit définie (la CI la fournit), sinon le bundler ne peut pas signer les artefacts de mise à jour.

## Stack technique

- **Tauri 2** pour l'application desktop et la communication entre le frontend et le backend.
- **Rust 2021** pour le traitement d'image, l'état de l'application et la génération MIDI en temps réel.
- **HTML, SCSS/CSS et JavaScript vanilla** pour l'interface utilisateur, sans framework ni bundler frontend.
- Crates Rust pertinentes :
  - [`tauri`](https://crates.io/crates/tauri) et [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) pour l'application et les boîtes de dialogue natives ;
  - [`tauri-plugin-updater`](https://crates.io/crates/tauri-plugin-updater) pour les mises à jour automatiques dans l'application ;
  - [`image`](https://crates.io/crates/image) pour le chargement et le traitement d'images ;
  - [`midir`](https://crates.io/crates/midir) pour la sortie MIDI en temps réel ;
  - [`serde`](https://crates.io/crates/serde) et [`serde_json`](https://crates.io/crates/serde_json) pour l'échange de données entre le frontend et le backend ;
  - [`base64`](https://crates.io/crates/base64) pour l'envoi des aperçus PNG au frontend.

## Conventions frontend

L'interface est du HTML/SCSS/JS pur (pas de framework, pas de bundler), organisée autour d'un modèle hybride utilitaires/composants, pour que le markup puisse se lire comme une description du rendu.

### Trois sortes de classes

- **Classes utilitaires** — classes à vocation unique, style Tailwind, écrites à la main dans `src/scss/_utilities.scss` (`flex`, `flex-col`, `items-center`, `gap-2`, `mb-3`, `text-muted`, `hidden`...). Elles sont chargées **en dernier** dans la cascade : une classe utilitaire surpasse toujours une classe de composant, et le markup peut ajuster n'importe quel composant sans toucher au SCSS. Seules les classes utilitaires réellement utilisées par le markup sont définies : en ajouter une (même nommage, mêmes échelles) quand le markup en a besoin.
- **Classes de composants** — une par région de l'interface ou rôle de contrôle (`.image-viewer`, `.controls`, `.mode-panel`, `.icon-btn`, `.synth-block`...), avec leurs états et pseudo-éléments imbriqués dans le SCSS. Elles vivent dans `scss/components/`, un fichier par zone de l'interface.
- **Classes d'état** — basculées par le JS à l'exécution : `.hidden` (avec `!important`), `.active`, `.locked`, `.picking`, `.confirm-pending`, `.dragging`, `.reversed`...

### Les ids sont des hooks, jamais stylés

Chaque `id` — dans les pages statiques comme dans les templates dynamiques — n'existe que comme point d'accroche stable pour `querySelector` ou comme calque de canvas ; **le CSS ne cible jamais un id**. Les éléments dynamiques répétés (cards de synthé, onglets) sont identifiés par des classes et un attribut `data-synth-id`, et non par des ids générés.

### Couleurs sémantiques — un sens chacune

- **Accent bleu** — bascule/mode actuellement actif ;
- **Rouge** — lecture en cours (affordance d'arrêt) et action destructrice en attente de confirmation ;
- **Vert** — confirmation transitoire.

### Organisation du SCSS

`styles.scss` n'est que le point d'entrée : son ordre de `@use` *est* l'ordre de la cascade — polices, reset, un fichier de composants par zone de l'interface, utilitaires en dernier. Les couleurs et tokens de design sont des variables `$color-*` dans `_variables.scss`. Le markup dynamique vit dans des templates HTML éditables (`src/templates/*.html`, chargés une fois par `js/templates.js` puis clonés par `main.js`) et suit les mêmes conventions ; les classes requêtées par le JS sont des hooks : ne jamais renommer l'une sans mettre à jour le `querySelector` correspondant.

### Compilation des styles

Le CSS compilé est commité (`src/css/styles.css` pour la fenêtre principale, `src/css/mirror.css` pour la fenêtre de projection, avec leurs source maps) : lancer l'application ne nécessite aucune étape de build. Après une modification du SCSS, recompiler les deux depuis `src/` avec dart-sass (outil autonome — Node.js n'est pas requis) :

```bash
sass scss/styles.scss:css/styles.css scss/mirror.scss:css/mirror.css
```

## Installation

### Prérequis

- [Rust](https://www.rust-lang.org/tools/install), avec Cargo.
- Les dépendances système requises par Tauri sur votre plateforme.
- Le CLI Tauri :

  ```bash
  cargo install tauri-cli
  ```

Node.js **n'est pas requis** : le frontend utilise du HTML, CSS et JavaScript vanilla, sans bundler ni gestionnaire de paquets frontend.

### Récupérer le projet

Depuis le répertoire du projet :

```bash
cd wysiwyl
```

## Utilisation

Lancer Wysiwyl en mode développement :

```bash
cargo tauri dev
```

Construire une version distribuable :

```bash
cargo tauri build
```

Note : en développement, `cargo tauri dev` sert `src/` en direct depuis le disque via le serveur intégré du CLI (aucun bundler). Ce serveur, tout comme le protocole d'assets de l'application (utilisé dans les builds distribués), injecte un `<script>` dans toute réponse HTML et retombe sur `index.html` pour les chemins inconnus — les fichiers HTML chargés au runtime (les templates de layout) sont donc parsés défensivement par `js/templates.js`, qui extrait l'élément racine attendu de chaque template au lieu de se fier au premier élément de la réponse.

Dans l'application :

1. Chargez une image et ajustez la taille de la grille, la saturation, le contraste, la luminosité et la postérisation. L'aperçu se met à jour en direct.
2. Ajoutez un ou plusieurs synthétiseurs, choisissez un port MIDI, un canal MIDI et une couleur pour chacun, et renommez-les en double-cliquant sur leur titre.
3. Tracez des zones sur l'image pour restreindre ce que chaque synthétiseur doit lire, choisissez un tempo par synthé, puis ouvrez les options avancées pour configurer le mode de traduction (monophonique/polyphonique), les longueurs de note, les filtres de plage MIDI et la vélocité minimum.
4. Appuyez sur Play sur un synthétiseur (ou « tout jouer ») pour commencer à entendre votre image.
5. Sauvegardez votre travail dans un fichier de session `.wysiwyl` (bouton de sauvegarde à côté des contrôles d'image) et rouvrez-le plus tard pour tout retrouver en place.

## Structure du projet

```text
wysiwyl/
├── Cargo.toml
├── LICENSE
├── README.md
├── README.fr.md
├── package.json
├── src/
│   ├── index.html
│   ├── viewer.html
│   ├── css/
│   │   ├── styles.css
│   │   └── mirror.css
│   ├── fonts/
│   ├── i18n/
│   ├── scss/
│   │   ├── styles.scss
│   │   ├── mirror.scss
│   │   ├── _variables.scss
│   │   ├── _mixins.scss
│   │   ├── _fonts.scss
│   │   ├── _reset.scss
│   │   ├── _utilities.scss
│   │   └── components/
│   └── js/
│       ├── main.js
│       ├── mirror.js
│       ├── viewer-render.js
│       └── i18n.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── state.rs
        ├── error.rs
        ├── config.rs
        ├── session.rs
        ├── image_processing.rs
        ├── synth.rs
        ├── metronome.rs
        ├── midi.rs
        └── updater.rs
```

Le backend expose des commandes Tauri pour charger les images, appliquer les ajustements, récupérer les données de pixels, gérer les synthétiseurs (création, lecture, canal et port MIDI, mode, zones, tempo, longueurs de note, plages MIDI, sens de lecture, vélocité), piloter le métronome commun, persister la configuration globale, sauvegarder/charger les sessions de travail, et vérifier/installer les mises à jour automatiques.

## Licence

Ce projet est distribué sous licence GNU GPL v3. Vous êtes libre d'utiliser, de modifier et de redistribuer ce code, à condition que toute œuvre dérivée soit également publiée sous GPLv3 avec ses sources. Voir le fichier [LICENSE](LICENSE) pour le texte complet.
