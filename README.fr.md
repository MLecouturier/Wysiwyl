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
- **Zones rectangulaires** — sélectionnez les pixels que chaque synthétiseur doit jouer en traçant des rectangles directement sur l'image. Tous les pixels sont sélectionnés par défaut ; un rectangle tracé depuis un pixel libre ajoute une zone, tandis qu'un rectangle tracé depuis un pixel déjà sélectionné retire ces pixels — un simple clic sélectionne ou désélectionne un pixel isolé. La ligne affiche également le nombre total de pixels sélectionnés. Les zones peuvent être modifiées pendant la lecture du synthé : la tête de lecture conserve le pixel qu'elle joue (elle est recalée dans la nouvelle sélection), et la zone sous la tête de lecture est verrouillée contre l'effacement — un tracé qui la touche est annulé. Vider les zones arrête toujours proprement le synthé.
- **Silences manuels** — maintenez Alt (Option) en utilisant l'outil de sélection rectangle ou lasso pour ajouter ou retirer des silences parmi les pixels sélectionnés : un pixel silencieux reste parcouru par la tête de lecture, il ne sonne simplement pas. Un rectangle tracé sur des silences existants les retire, sinon il met en silence les pixels sélectionnés qu'il couvre ; le lasso bascule chaque pixel sélectionné englobé. Les pixels silenciés reçoivent le même voile et glyphe de silence que les pixels trop sombres, et vivent toujours au sein de la sélection : désélectionner un pixel supprime son silence.
- **Tempo par synthé** — chaque synthétiseur peut jouer à une fraction du tempo du métronome commun (1/1, 3/4, 2/3, 1/2, 1/3 ou 1/4 du BPM global), permettant aux synthés de se désynchroniser pour dynamiser la musique.
- **Nom personnalisé** — double-cliquez sur le titre d'un synthétiseur pour le renommer ; le nom est conservé dans les sessions.
- **Port de sortie MIDI par synthétiseur** — chaque synthé peut envoyer ses notes vers une interface MIDI différente. Les connexions sont ouvertes paresseusement à la première utilisation, et le premier port disponible est connecté automatiquement au démarrage.
- **Sens de lecture** — un bouton cyclique sélectionne l'ordre de lecture de la séquence de pixels : gauche → droite, droite → gauche, haut → bas ou bas → haut. Un bouton « tri » change le rapport des zones à cet ordre : inactif, chaque zone est lue intégralement, l'une après l'autre, dans l'ordre où elles ont été dessinées ; actif, les pixels de toutes les zones sont fusionnés et lus selon leur position absolue dans l'image — un unique balayage continu. La tête de lecture conserve son pixel lors du basculement.
- **Lecture en boucle, aller-retour ou ponctuelle** — un synthétiseur peut boucler indéfiniment sur ses zones, rebondir entre les bornes de la séquence (aller-retour), ou lire la séquence une seule fois puis s'arrêter. Boucle et aller-retour sont mutuellement exclusifs et peuvent être tous deux inactifs.
- **Longueurs de note** — des boutons (double croche, croche, noire, blanche, ronde) font correspondre la luminosité du pixel à une durée parmi les longueurs activées (les niveaux de luminosité 0–127 sont découpés en autant de bandes égales). Chaque pixel est joué pendant exactement la durée de sa note : le contraste de luminosité de l'image se traduit ainsi directement en rythme. Un bouton inverse le sens luminosité → longueur (sombre = long au lieu de clair = long) ; la noire reste toujours active.
- **Filtres de plage MIDI** — les boutons basses (21–47), médiums (48–71) et aigus (72–108) restreignent les notes qu'un synthétiseur peut jouer. Les filtres se cumulent pour étendre la plage autorisée ; aucun bouton actif = plage complète 0–127. La note brute dérivée du pixel est recalée proportionnellement dans la plage autorisée : la hauteur monte graduellement et en continu de la borne basse à la borne haute à mesure que la teinte (ou la valeur du canal) augmente. Le mode monophonique possède un filtre unique ; chaque voix R/V/B du mode polyphonique possède le sien.
- **Contrôles de lecture** — lecture/arrêt, rembobinage (replace la tête de lecture au début de la séquence) et pas en avant (avance manuellement d'un pixel pendant une pause, en le jouant sur sa longueur de note).
- **Seuil de luminosité** — un double slider définit la plage de luminosité qu'un pixel doit respecter pour être audible ; les pixels hors de cette plage sont silencieusement ignorés.
- **Vélocité minimum** — définit le plancher de la plage de vélocité ; la saturation du pixel est transposée entre ce plancher et la vélocité maximale (127). Les couleurs vives sont jouées avec une attaque plus forte, les zones achromatiques plus délicatement.
- **Choix du canal MIDI** par synthétiseur (16 canaux disponibles), verrouillé pendant la lecture.
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

### Sessions de travail

- **Sauvegarde de l'état complet** dans un unique fichier `.wysiwyl` autoportant (boîte de dialogue d'enregistrement native) : l'image originale (embarquée en base64 PNG), les réglages de traitement d'image, le tempo du métronome, et chaque synthétiseur avec sa configuration complète (nom, couleur, zones, tempo, mode, longueurs de note, plages MIDI, seuils, vélocité, canal et port MIDI, sens de lecture, lecture triée, boucle/aller-retour).
- **Réouverture d'une session** via une boîte de dialogue native : l'image est re-dérivée de l'originale avec les réglages stockés, et tous les synthétiseurs sont recréés exactement tels qu'ils ont été laissés. L'état de lecture (positions des têtes de lecture, notes en cours) n'est volontairement pas restauré : tout repart du début.

### Configuration globale

Un fichier de configuration JSON (ouvrable via le bouton engrenage des paramètres de l'application) regroupe les options globales, éditables à la main dans un éditeur de texte et appliquées au prochain démarrage :

- **`max_image_size`** — plus grand côté autorisé pour les images importées ; les images plus grandes sont redimensionnées à l'import (0 = illimitée).
- **`default_bpm`** — tempo du métronome utilisé au démarrage.
- **`default_synth`** — gabarit appliqué à chaque nouveau synthétiseur ; n'importe quel synthé existant peut être enregistré comme gabarit via son bouton marque-page (« Utiliser ce synthé comme modèle par défaut »).

## Stack technique

- **Tauri 2** pour l'application desktop et la communication entre le frontend et le backend.
- **Rust 2021** pour le traitement d'image, l'état de l'application et la génération MIDI en temps réel.
- **HTML, SCSS/CSS et JavaScript vanilla** pour l'interface utilisateur, sans framework ni bundler frontend.
- Crates Rust pertinentes :
  - [`tauri`](https://crates.io/crates/tauri) et [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) pour l'application et les boîtes de dialogue natives ;
  - [`image`](https://crates.io/crates/image) pour le chargement et le traitement d'images ;
  - [`midir`](https://crates.io/crates/midir) pour la sortie MIDI en temps réel ;
  - [`serde`](https://crates.io/crates/serde) et [`serde_json`](https://crates.io/crates/serde_json) pour l'échange de données entre le frontend et le backend ;
  - [`base64`](https://crates.io/crates/base64) pour l'envoi des aperçus PNG au frontend.

## Conventions frontend

L'interface est du HTML/SCSS/JS pur (pas de framework, pas de bundler), organisée autour d'un modèle hybride utilitaires/composants, pour que le markup puisse se lire comme une description du rendu.

### Trois sortes de classes

- **Classes utilitaires** — classes à vocation unique, style Tailwind, écrites à la main dans `src/scss/_utilities.scss` (`flex`, `flex-col`, `items-center`, `gap-2`, `mb-3`, `text-muted`, `hidden`...). Elles sont chargées **en dernier** dans la cascade : une classe utilitaire surpasse toujours une classe de composant, et le markup peut ajuster n'importe quel composant sans toucher au SCSS. Les échelles d'espacement et de tailles de police sont générées depuis des maps SCSS en tête de fichier.
- **Classes de composants** — une par région de l'interface ou rôle de contrôle (`.image-viewer`, `.controls`, `.mode-panel`, `.icon-btn`, `.synth-block`...), avec leurs états et pseudo-éléments imbriqués dans le SCSS. Elles vivent dans `scss/components/`, un fichier par zone de l'interface.
- **Classes d'état** — basculées par le JS à l'exécution : `.hidden` (avec `!important`), `.active`, `.locked`, `.picking`, `.compact`, `.confirm-pending`, `.dragging`, `.reversed`...

### Les ids sont des hooks, jamais stylés

Chaque `id` — dans les pages statiques comme dans les templates dynamiques — n'existe que comme point d'accroche stable pour `querySelector` ou comme calque de canvas ; **le CSS ne cible jamais un id**. Les éléments dynamiques répétés (cards de synthé, onglets) sont identifiés par des classes et un attribut `data-synth-id`, et non par des ids générés.

### Couleurs sémantiques — un sens chacune

- **Accent bleu** — bascule/mode actuellement actif ;
- **Rouge** — lecture en cours (affordance d'arrêt) et action destructrice en attente de confirmation ;
- **Vert** — confirmation transitoire.

### Organisation du SCSS

`styles.scss` n'est que le point d'entrée : son ordre de `@use` *est* l'ordre de la cascade — polices, reset, un fichier de composants par zone de l'interface, utilitaires en dernier. Les couleurs et tokens de design sont des variables `$color-*` dans `_variables.scss`. Le markup dynamique construit par les templates de `main.js` suit les mêmes conventions ; les classes requêtées par le JS sont des hooks : ne jamais renommer l'une sans mettre à jour le `querySelector` correspondant.

### Compilation des styles

Le CSS compilé est commité (`src/css/styles.css` + source map) : lancer l'application ne nécessite aucune étape de build. Après une modification du SCSS, recompiler avec dart-sass (outil autonome — Node.js n'est pas requis) :

```bash
sass scss/styles.scss css/styles.css
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

Dans l'application :

1. Chargez une image et ajustez la taille de la grille, la saturation, le contraste, la luminosité et la postérisation. L'aperçu se met à jour en direct.
2. Ajoutez un ou plusieurs synthétiseurs, choisissez un port MIDI, un canal MIDI et une couleur pour chacun, et renommez-les en double-cliquant sur leur titre.
3. Tracez des zones sur l'image pour restreindre ce que chaque synthétiseur doit lire, choisissez un tempo par synthé, puis ouvrez les options avancées pour configurer le mode de traduction (monophonique/polyphonique), les longueurs de note, les filtres de plage MIDI, le seuil de luminosité et la vélocité minimum.
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
        └── midi.rs
```

Le backend expose des commandes Tauri pour charger les images, appliquer les ajustements, récupérer les données de pixels, gérer les synthétiseurs (création, lecture, canal et port MIDI, mode, zones, tempo, longueurs de note, plages MIDI, sens de lecture, seuils, vélocité), piloter le métronome commun, persister la configuration globale et sauvegarder/charger les sessions de travail.

## Licence

Ce projet est distribué sous licence GNU GPL v3. Vous êtes libre d'utiliser, de modifier et de redistribuer ce code, à condition que toute œuvre dérivée soit également publiée sous GPLv3 avec ses sources. Voir le fichier [LICENSE](LICENSE) pour le texte complet.
