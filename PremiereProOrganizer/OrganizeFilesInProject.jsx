// =============================================================================
//  ISMA ORGANIZER v2.5 — côté hôte (ExtendScript)
//
//  ⚠️ TOUT vit dans UN SEUL global, IsmaOrganizer.
//
//  Premiere n'a qu'UN moteur ExtendScript, partagé par tous les panneaux. Les
//  fichiers .jsx y sont chargés par $.evalFile, et le dernier chargé gagne.
//  Jusqu'en 2.2 ce fichier définissait une quarantaine de fonctions au premier
//  niveau (findBinsDeep, getChildren, isVideo…). Le panneau Pinterest B-roll en
//  a écrasé une avec une signature différente : findOrMergeBin() perdait sa
//  liste « Ignorer », sortait des chutiers protégés vers la racine et y
//  fusionnait leur contenu. Un clic dans un AUTRE panneau réorganisait donc le
//  projet à l'insu de l'utilisateur. Un seul nom global, choisi pour être
//  unique ; rien d'autre ne fuit.
//
//  Flux d'un rangement :
//    1. Collecter les éléments à examiner — selon le MODE :
//         incremental (défaut) : la racine + le premier niveau des chutiers
//                                que ce plugin possède + ce qu'un import a
//                                glissé DANS ces chutiers (cf.
//                                collectInsideOwned). On n'entre JAMAIS dans
//                                un chutier créé par l'utilisateur.
//         full                 : tout le projet, récursivement (ancien
//                                comportement, action explicite).
//    2. Catégoriser (vidéo, b-roll, audio ± musique/SFX/voix, images,
//       animations, styles, séquences, imbriquées, exports, hors-ligne, autres)
//    3. Créer les chutiers manquants, déplacer, étiqueter
//    4. Supprimer les chutiers vides — UNIQUEMENT ceux que ce plugin possède
//       ou qu'il vient lui-même de vider. Un chutier vide préparé par
//       l'utilisateur n'est jamais touché.
//
//  API appelée par le panneau (toutes renvoient du JSON) :
//    IsmaOrganizer.resetAndOrganize(payloadJSON)  → rapport + instantané d'annulation
//    IsmaOrganizer.previewOrganize(payloadJSON)   → même calcul, rien n'est déplacé
//    IsmaOrganizer.undoOrganize(snapshotJSON)     → remet chaque élément d'où il vient
//    IsmaOrganizer.backToNormal(ignoredJSON)      → tout à plat (hérité)
//    IsmaOrganizer.getProjectSignature()          → signature légère pour l'auto
//    IsmaOrganizer.diagnoseNested()               → ce que voit le scan des imbriquées
//    IsmaOrganizer.importWatched(payloadJSON)     → pont Pinterest
//
//  Payload de resetAndOrganize / previewOrganize :
//    {
//      mode:           "incremental" | "full",
//      names:          { video, broll, audio, images, anim, styles, seq,
//                        nested, exports, other, offline },
//      ignored:        ["nom1", "nom2"],
//      brollPatterns:  ["dji", "gopr", "/b-roll/"],   // avec « / » → chemin complet
//      exportPatterns: ["/exports/", "/renders/"],    // toujours sur le chemin
//      audioSplit:     true,
//      sfxPatterns:    ["sfx", "whoosh", …],
//      voicePatterns:  ["vo", "voix", …],
//      colorLabels:    true,
//      refreshView:    true,
//      only:           "sequences"   // optionnel : ne range QUE les séquences
//    }
// =============================================================================

// JSON pour ExtendScript. Le moteur de Premiere n'en a pas : sur un poste où
// un autre panneau a chargé json2 il existe, sur une installation propre il
// manque, et chaque appel au plugin échouait. Défini seulement s'il manque
// (d'après json2 de Douglas Crockford, domaine public). Code en ASCII pur : les
// caractères spéciaux sont fabriqués par String.fromCharCode.
if (typeof JSON !== "object" || JSON === null) { JSON = {}; }
(function () {
    var ESC = /[\\"\x00-\x1f]/g;
    var META = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", "\"": "\\\"", "\\": "\\\\" };
    // U+2028 / U+2029 : valides en JSON, pas dans un littéral ES3 que eval lit.
    var LS = new RegExp("[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]", "g");
    function hex4(c) { return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4); }
    function quote(s) {
        ESC.lastIndex = 0;
        if (!ESC.test(s)) return "\"" + s + "\"";
        ESC.lastIndex = 0;
        return "\"" + s.replace(ESC, function (a) {
            var c = META[a];
            return typeof c === "string" ? c : hex4(a);
        }) + "\"";
    }
    function str(key, holder) {
        var i, k, v, partial, value = holder[key];
        switch (typeof value) {
        case "string":  return quote(value);
        case "number":  return isFinite(value) ? String(value) : "null";
        case "boolean": return String(value);
        case "object":
            if (!value) return "null";
            partial = [];
            if (Object.prototype.toString.apply(value) === "[object Array]") {
                for (i = 0; i < value.length; i++) partial[i] = str(i, value) || "null";
                return "[" + partial.join(",") + "]";
            }
            for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    v = str(k, value);
                    if (v) partial.push(quote(k) + ":" + v);
                }
            }
            return "{" + partial.join(",") + "}";
        }
        return undefined;
    }
    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) { return str("", { "": value }); };
    }
    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            text = String(text).replace(LS, hex4);
            if (/^[\],:{}\s]*$/.test(text
                    .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                    .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                    .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) {
                return eval("(" + text + ")");
            }
            throw new SyntaxError("JSON.parse");
        };
    }
}());

var IsmaOrganizer = (function () {

var VERSION = "2.7.1";

// Étiquettes Premiere Pro : 0 Violet, 1 Iris, 2 Caribbean, 3 Lavender,
// 4 Cerulean, 5 Forest, 6 Rose, 7 Mango, 8 Purple, 9 Blue, 10 Teal,
// 11 Magenta, 12 Tan, 13 Green, 14 Brown, 15 Yellow
var CAT_COLORS = {
    video:   4,   // Cerulean
    broll:   10,  // Teal
    audio:   13,  // Green
    images:  15,  // Yellow
    anim:    8,   // Purple
    styles:  11,  // Magenta
    seq:     7,   // Mango
    nested:  3,   // Lavender
    exports: 9,   // Blue
    other:   12,  // Tan
    offline: 6    // Rose
};

// Ordre de traitement ET d'affichage dans le rapport.
var CAT_ORDER = ["video", "broll", "audio", "images", "anim", "styles",
                 "seq", "nested", "exports", "other", "offline"];

// Sous-chutiers audio quand la séparation est activée. Noms fixes : ils
// servent aussi à reconnaître ces chutiers comme les nôtres au passage suivant.
var AUDIO_SUB = { music: "Music", sfx: "SFX", voice: "Voice" };

// Sous-chutier du chutier des séquences : les sauvegardes que créent AutoCut
// (« AutoCut-Backup<||>… ») et AutoPod (« P__A0755 AutoPod Backup 09-23-2026
// 22:16:13 ») — mesurées dans les projets réels, elles se mêlaient aux vrais
// montages datés dans « 01 sequence ».
var SEQ_SUB = { backup: "Backups" };

// Sous-chutiers par catégorie : où une entrée avec `sub` va, et quels noms
// d'enfants un chutier de catégorie possède.
var SUBS = { audio: AUDIO_SUB, seq: SEQ_SUB };

// Noms de chutiers de catégorie des anciennes versions, relevés dans les
// projets réels (« Client B 3 », « Client C ads ») : les versions sans numéro,
// et « 05 screenshots » pour les images. Une liste FERMÉE — retirer le numéro
// de n'importe quel nom (« 10 exports » → « exports ») aurait fait d'un
// chutier « Exports » de l'utilisateur un chutier du plugin, vidé puis
// supprimé.
var LEGACY_NAMES = {
    seq:    ["sequence"],
    nested: ["nested sequence"],
    video:  ["video"],
    audio:  ["music & sound effect"],
    images: ["05 screenshots", "screenshots"],
    styles: ["styles"],
    other:  ["other"]
};

// Sauvegardes de séquences créées par AutoCut (« AutoCut-Backup<||>… ») et
// AutoPod (« P__A0755 AutoPod Backup 09-23-2026 22:16:13 »). Pas /backup/ tout
// court : « Backup plan - FINAL » est un vrai montage.
var BACKUP_NAME_RE = /autocut-backup|autopod backup/i;

var REFRESH_BIN_NAME = "__isma_refresh__";

// =============================================================================
//  API — Rangement
// =============================================================================

function resetAndOrganize(payloadJSON) {
    if (!app.project || !app.project.rootItem) {
        return JSON.stringify({ error: "no-project" });
    }

    var payload = parsePayload(payloadJSON);
    if (!payload) return JSON.stringify({ error: "bad-payload" });
    var ctx  = buildContext(payload);
    var plan = buildPlan(ctx);
    var report = applyPlan(ctx, plan);

    // Le ménage final ne doit jamais faire échouer un rangement déjà terminé.
    // Sans ce filet, une exception ici remonte en « EvalScript error » et le
    // panneau annonce un échec alors que tout a été rangé correctement — et
    // l'utilisateur relance tout le traitement pour rien.
    // Incrémental : seuls les chutiers que ce passage connaît peuvent être
    // vides par sa faute — inutile de parcourir tout l'arbre du projet (deux
    // passes, 5 000 appels sur un projet de 1 200 éléments) pour les trouver.
    // Le re-tri complet, lui, vide des chutiers n'importe où : parcours complet.
    try {
        if (ctx.mode === "full") deleteEmptyBins(ctx.root, ctx.ignored, ownedOrEmptied(ctx));
        else deleteEmptyKnownBins(ctx);
    } catch (e) {}
    // Le rapport nomme les restes d'import vraiment supprimés, pas ceux vus.
    report.leftoverBins = ctx.leftoverDeleted;
    report.emptiedBins = ctx.userShellDeleted;

    // En DERNIER : la racine. deleteEmptyBins() vient de modifier l'arbre,
    // donc le panneau est de nouveau périmé — c'est le tout dernier geste
    // sur le projet qui doit être le coup de pouce.
    if (ctx.refreshView) nudgeBinLayout(ctx.root);

    return JSON.stringify(report);
}

// Même calcul que resetAndOrganize, sans toucher au projet. Le panneau affiche
// « 14 vidéos, 6 b-roll… Appliquer ? » avant de bouger quoi que ce soit.
function previewOrganize(payloadJSON) {
    if (!app.project || !app.project.rootItem) {
        return JSON.stringify({ error: "no-project" });
    }

    var payload = parsePayload(payloadJSON);
    if (!payload) return JSON.stringify({ error: "bad-payload" });
    var ctx  = buildContext(payload);
    var plan = buildPlan(ctx);

    var out = {
        ok: true, preview: true, mode: ctx.mode,
        counts: {}, samples: {}, total: 0, unchanged: 0,
        duplicates: plan.dupNames, skipped: [],
        debug: { version: VERSION, nestedScan: plan.nestedScan, seqDecisions: plan.seqDecisions },
        unusedNested: plan.unusedNested,
        onlySequences: ctx.onlySequences,
        seqTotal: seqTotal(),
        nestedFound: plan.cats.nested.length,
        scan: plan.nestedScan ? plan.nestedScan.mode : "none",
        clipsRead: plan.nestedScan ? plan.nestedScan.clipsSeen : 0,
        driveMissing: plan.driveMissing || {},
        keptSeqs: plan.keptSeqs || [],
        leftoverBins: ctx.leftoverBins,
        byRule: plan.byRule || 0
    };

    var pendingFrom = [];
    for (var c = 0; c < CAT_ORDER.length; c++) {
        var cat = CAT_ORDER[c];
        var entries = plan.cats[cat];
        if (!entries.length) continue;
        if (isNameIgnored(ctx.p.names[cat], ctx.ignored)) {
            out.skipped.push(String(ctx.p.names[cat]));
            continue;
        }
        var toMove = 0;
        out.samples[cat] = [];
        for (var i = 0; i < entries.length; i++) {
            if (alreadyThere(ctx, entries[i], cat)) { out.unchanged++; continue; }
            toMove++;
            pendingFrom.push(String(entries[i].from));
            if (out.samples[cat].length < 3) {
                out.samples[cat].push(String(entries[i].item.name));
            }
        }
        if (toMove > 0) { out.counts[cat] = toMove; out.total += toMove; }
    }

    // « Sera vidé » : seulement les restes d'où quelque chose va sortir.
    out.leftoverBins = [];
    for (var lb = 0; lb < ctx.leftoverBins.length; lb++) {
        var lp = ctx.leftoverBins[lb];
        for (var pf = 0; pf < pendingFrom.length; pf++) {
            if (pendingFrom[pf] === lp || pendingFrom[pf].indexOf(lp + "/") === 0) { out.leftoverBins.push(lp); break; }
        }
    }

    return JSON.stringify(out);
}

// Remet chaque élément dans le chutier d'où le dernier rangement l'a sorti.
//   snapshot = { items: [{ id, from }], bins: [nodeId, …], names: {…} }
// « from » est un chemin de chutiers depuis la racine (« 02 video/Cuisine »),
// recréé s'il a été supprimé entre-temps. Les chutiers que le rangement avait
// créés et qui se retrouvent vides sont retirés.
function undoOrganize(snapshotJSON) {
    if (!app.project || !app.project.rootItem) {
        return JSON.stringify({ error: "no-project" });
    }

    var snap = parsePayload(snapshotJSON);
    if (!snap) return JSON.stringify({ error: "bad-payload" });

    // Les nodeId sont propres à chaque projet : appliquer l'instantané d'un
    // autre projet déplacerait des éléments sans rapport dans des chutiers
    // recréés à partir de ses chemins. On refuse net.
    var here = "";
    try { here = String(app.project.path); } catch (ePath) {}
    if (snap.project && here && snap.project !== here) {
        return JSON.stringify({ error: "wrong-project", project: here, expected: snap.project });
    }

    var root = app.project.rootItem;
    var out  = { ok: true, restored: 0, failed: 0, missing: 0 };

    // Éléments ET chutiers : un rangement complet déplace aussi des
    // sous-chutiers (fusion des doublons), qu'il faut savoir remettre.
    var byId = {};
    indexEverything(root, byId);

    var items = snap.items || [];
    for (var i = 0; i < items.length; i++) {
        var item = byId[idKey(items[i].id)];
        if (!item) { out.missing++; continue; }
        try {
            var dest = null;
            if (items[i].fromId) {
                var known = byId[idKey(items[i].fromId)];
                if (known && known.type === 2) dest = known;
            }
            if (!dest) dest = resolveBinPath(root, items[i].fromParts || items[i].from);
            if (dest.nodeId === item.nodeId) continue;   // un chutier ne rentre pas dans lui-même
            moveOrThrow(item, dest);
            out.restored++;
            if (typeof items[i].label === "number") {
                try { item.setColorLabel(items[i].label); } catch (eLabel) {}
            }
        } catch (e) {
            out.failed++;
        }
    }

    // Seuls les chutiers de CE rangement peuvent partir, et seulement vides.
    var deletable = {};
    var bins = snap.bins || [];
    for (var b = 0; b < bins.length; b++) deletable[idKey(bins[b])] = true;
    try {
        // Sans cascade : un chutier de catégorie vide AVANT le rangement (un
        // modèle de projet) n'est pas à supprimer parce que son sous-chutier
        // créé par le rangement part.
        deleteEmptyBins(root, [], function (bin) {
            return !!deletable[idKey(bin.nodeId)] || sameName(bin.name, REFRESH_BIN_NAME);
        }, true);
    } catch (e2) {}

    nudgeBinLayout(root);
    return JSON.stringify(out);
}

// =============================================================================
//  API — BACK TO NORMAL (hérité) : tout revient à la racine, tous les
//  chutiers vidés sont supprimés. Action explicite, confirmée côté panneau.
// =============================================================================

function backToNormal(ignoredJSON) {
    if (!app.project || !app.project.rootItem) {
        return JSON.stringify({ error: "no-project" });
    }

    var root = app.project.rootItem;

    // « Ignorer » vaut aussi ici. Sans ça, remettre à plat vidait et supprimait
    // des chutiers que l'utilisateur avait explicitement demandé de ne pas
    // toucher — y compris des chutiers que ce plugin n'a jamais créés.
    var ignored = [];
    try { ignored = normalizeList(JSON.parse(ignoredJSON)); } catch (e) {}

    var entries = [];
    collectItemsDeep(root, entries, ignored, []);

    var moved = 0;
    var emptied = {};
    var undo = { items: [], bins: [], project: "" };
    try { undo.project = String(app.project.path); } catch (eP) {}
    for (var i = 0; i < entries.length; i++) {
        try {
            if (!entries[i].fromParts.length) continue;      // déjà à la racine
            if (entries[i].parent && entries[i].parent.nodeId !== root.nodeId) {
                emptied[idKey(entries[i].parent.nodeId)] = true;
            }
            moveOrThrow(entries[i].item, root);
            moved++;
            // Même instantané que pour un rangement : « Annuler » recrée les
            // chutiers vidés et y remet chaque élément.
            undo.items.push({ id: String(entries[i].item.nodeId), from: entries[i].from, fromParts: entries[i].fromParts });
        } catch (e) {}
    }

    // À plat = les chutiers qu'on vient de vider disparaissent, plus le
    // temporaire de rafraîchissement. Un chutier vide que l'utilisateur avait
    // préparé reste — même s'il s'appelle « Music » ou « 02 video ».
    try {
        deleteEmptyBins(root, ignored, function (bin) {
            return !!emptied[idKey(bin.nodeId)] || sameName(bin.name, REFRESH_BIN_NAME);
        });
    } catch (eDel) {}
    nudgeBinLayout(root);

    // Les éléments bloqués restent dans leur chutier (qui n'est donc pas
    // supprimé) : rien n'est perdu, mais il faut le dire.
    return JSON.stringify({
        total:  moved,
        failed: entries.length - moved - skippedAtRoot(entries),
        kept:   ignored.length,
        project: undo.project,
        undo:   undo
    });
}

function skippedAtRoot(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) if (!entries[i].fromParts.length) n++;
    return n;
}

// =============================================================================
//  API — Signature légère du projet (auto-organisation)
//
//  Le panneau interroge cette fonction en boucle (toutes les quelques secondes)
//  pour savoir si le projet a changé : autre projet ouvert, nouveaux imports.
//  Elle doit rester TRÈS rapide → aucun parcours récursif, uniquement des
//  compteurs de premier niveau. Un scan complet ne se fait qu'au moment
//  d'organiser réellement.
//
//  rootCount grimpe dès qu'un média est importé (Premiere le dépose à la
//  racine), ce qui suffit à détecter un import sans coûter quoi que ce soit.
// =============================================================================

function getProjectSignature() {
    var sig = { ok: false, path: "", name: "", rootCount: 0, seqCount: 0, rootSeqs: 0, rootMedia: 0, version: VERSION };
    try {
        if (!app.project || !app.project.rootItem) return JSON.stringify(sig);
        sig.ok = true;
        try { sig.path = String(app.project.path); } catch (e) {}
        try { sig.name = String(app.project.name); } catch (e) {}
        try { sig.rootCount = app.project.rootItem.children.numItems; } catch (e) {}
        try { sig.seqCount = app.project.sequences.numSequences; } catch (e) {}
        // Séquences posées à la RACINE : c'est là que Premiere dépose une
        // imbrication (« Nested Sequence 131 ») créée en pleine session —
        // mesuré dans le journal d'activité, racine 49 → 53 en quatre nests.
        // Premier niveau seulement, plafonné : la signature doit rester
        // quasi gratuite, elle est demandée toutes les six secondes.
        try {
            var col = app.project.rootItem.children, n = Math.min(col.numItems, 2000);
            for (var i = 0; i < n; i++) {
                try {
                    if (col[i].type === 2) continue;
                    if (isSequenceItem(col[i])) sig.rootSeqs++;
                    else sig.rootMedia++;
                } catch (e1) {}
            }
        } catch (e2) {}
    } catch (e) {}
    return JSON.stringify(sig);
}

// =============================================================================
//  API — DIAGNOSTIC : ce que le scan des séquences imbriquées voit vraiment
//
//  Le classement séquence / imbriquée dépend d'une seule chose : ce que
//  Premiere laisse lire des pistes des AUTRES séquences. Quand cette lecture
//  ne renvoie rien, aucune séquence n'est reconnue comme imbriquée et tout
//  atterrit dans le même chutier — sans le moindre message, puisque chaque
//  accès à l'hôte est protégé par un catch. Cette fonction rend le scan
//  observable. Appelée par le bouton « Sequence diagnostic ».
// =============================================================================

function diagnoseNested() {
    if (!app.project || !app.project.rootItem) {
        return JSON.stringify({ error: "no-project" });
    }

    var nested = getNestedInfo({ activeOnly: false });
    var out = {
        ok: true,
        scan: {
            seqCount:    nested.seqCount,
            tracksSeen:  nested.tracksSeen,
            clipsSeen:   nested.clipsSeen,
            nestedFound: nested.nestedFound,
            opened:      nested.opened,
            errors:      nested.errors
        },
        items: []
    };

    var entries = [];
    collectItemsDeep(app.project.rootItem, entries, null, []);
    for (var i = 0; i < entries.length; i++) {
        try {
            var it = entries[i].item;
            if (!isSequenceItem(it)) continue;
            out.items.push({
                name:   String(it.name),
                nodeId: String(it.nodeId),
                type:   it.type,
                nested: isNestedSeq(it, nested) ? 1 : 0
            });
        } catch (e) {}
    }

    return JSON.stringify(out);
}

// =============================================================================
//  API — PONT PINTEREST : import automatique depuis un dossier surveillé
//
//    importWatched({ paths, names: {broll, images, other}, ignored, colorLabels })
//    → { imported, skipped, failed, noProject, byCat }
//
//  ⚠️ NE PAS SUPPRIMER. Le panneau appelle cette fonction ; sans elle
//  l'interrupteur « Pinterest bridge » reste affiché et chaque import échoue en
//  silence. Cette fonction a déjà été perdue DEUX fois en réécrivant ce fichier.
//  tests/check-panel.mjs le détecte : il vérifie que toute fonction appelée par
//  le panneau existe bien ici ET est exposée dans l'objet renvoyé en bas.
//
//  On importe à la racine PUIS on déplace, plutôt que de passer un chutier
//  cible à importFiles() : selon les versions de Premiere ce 3e argument est
//  ignoré en silence et le fichier atterrit à la racine sans qu'on le sache.
// =============================================================================

function importWatched(payloadJSON) {
    var out = { imported: 0, skipped: 0, failed: 0, noProject: false, byCat: {} };

    if (!app.project || !app.project.rootItem) {
        out.noProject = true;
        return JSON.stringify(out);
    }

    var p = parsePayload(payloadJSON);
    if (!p) { out.failed = 1; return JSON.stringify(out); }
    var root      = app.project.rootItem;
    var ignored   = normalizeList(p.ignored);
    var useColors = (p.colorLabels !== false);
    var paths     = p.paths || [];
    if (!p.names) p.names = {};

    // Un fichier déjà dans le projet ne doit pas être réimporté, même si le
    // panneau ne l'a pas encore vu passer (import à la main par ailleurs).
    var already  = existingMediaPaths(root);
    var toImport = [];
    for (var i = 0; i < paths.length; i++) {
        var candidate = String(paths[i]);
        if (already[candidate.toLowerCase()]) { out.skipped++; continue; }
        toImport.push(candidate);
    }
    if (toImport.length === 0) return JSON.stringify(out);

    var beforeIds = {};
    var before = [];
    collectItemsDeep(root, before, null, []);
    for (var b = 0; b < before.length; b++) beforeIds[idKey(before[b].item.nodeId)] = true;

    try {
        app.project.importFiles(toImport, true, root, false);
    } catch (e) {
        out.failed = toImport.length;
        return JSON.stringify(out);
    }

    var after = [];
    collectItemsDeep(root, after, null, []);

    for (var a = 0; a < after.length; a++) {
        var item = after[a].item;
        if (beforeIds[idKey(item.nodeId)]) continue;

        var mp = "";
        try { mp = item.getMediaPath(); } catch (eP) {}
        var fname = mp ? String(mp).replace(/\\/g, "/").split("/").pop() : "";
        var ext   = getExtFrom(fname, item.name);
        var cat   = isVideo(ext) ? "broll" : (isImage(ext) ? "images" : "other");

        var binName = p.names[cat] || p.names.other;
        if (!binName) { out.failed++; continue; }
        // Chutier de destination sur la liste « Ignorer » : le fichier reste à
        // la racine plutôt que d'aller dans un DEUXIÈME chutier du même nom.
        if (isNameIgnored(binName, ignored)) { out.skipped++; continue; }

        try {
            // Jamais de fusion en profondeur ici : le pont dépose, il ne range pas.
            var bin = findOrMergeBin(binName, root, ignored, false, null);
            if (!bin) { out.failed++; continue; }
            if (useColors && CAT_COLORS[cat] !== undefined) {
                try { bin.setColorLabel(CAT_COLORS[cat]); } catch (eB) {}
            }
            moveOrThrow(item, bin);
            if (useColors && CAT_COLORS[cat] !== undefined) {
                try { item.setColorLabel(CAT_COLORS[cat]); } catch (eL) {}
            }
            out.byCat[cat] = (out.byCat[cat] || 0) + 1;
            out.imported++;
        } catch (eMove) {
            out.failed++;
        }
    }

    if (out.imported === 0 && out.failed === 0) out.failed = toImport.length;
    return JSON.stringify(out);
}

/** Chemins média déjà présents dans le projet, en minuscules, pour dédupliquer. */
function existingMediaPaths(root) {
    var map = {};
    var entries = [];
    collectItemsDeep(root, entries, null, []);
    for (var i = 0; i < entries.length; i++) {
        try {
            var mp = entries[i].item.getMediaPath();
            if (mp && mp.length > 0) map[String(mp).toLowerCase()] = true;
        } catch (e) {}
    }
    return map;
}

// =============================================================================
//  CONTEXTE d'un rangement — payload normalisé + chutiers que l'on possède
// =============================================================================

var DEFAULT_NAMES = {
    video: "02 video", broll: "03 b-roll", audio: "04 music & sound effect",
    images: "05 images", anim: "06 animations & templates", styles: "07 styles",
    seq: "01 sequence", nested: "08 nested sequence", exports: "10 exports",
    other: "09 other", offline: "00 offline"
};

function buildContext(p) {
    // Un nom manquant devient son défaut, un nom bordé d'espaces est nettoyé
    // UNE fois ici : sinon « 04 audio  » ne retrouve jamais « 04 audio » et
    // chaque passage annonce des déplacements qui n'en sont pas.
    var names = {};
    for (var k in DEFAULT_NAMES) {
        if (!DEFAULT_NAMES.hasOwnProperty(k)) continue;
        var v = (p.names && p.names[k] !== undefined && p.names[k] !== null) ? trimStr(p.names[k]) : "";
        names[k] = v.length ? v : DEFAULT_NAMES[k];
    }
    p.names = names;

    var ctx = {
        p:              p,
        root:           app.project.rootItem,
        mode:           (p.mode === "full") ? "full" : "incremental",
        ignored:        normalizeList(p.ignored),
        brollPatterns:  normalizeList(p.brollPatterns),
        exportPatterns: normalizeList(p.exportPatterns),
        sfxPatterns:    normalizeList(p.sfxPatterns),
        voicePatterns:  normalizeList(p.voicePatterns),
        // Règles de l'utilisateur, par NOM (panneau : « Always nested »,
        // « Always edits ») : elles passent avant la lecture des timelines.
        seqRules:       { nested: wordRules(p.nestedPatterns), seq: wordRules(p.seqPatterns) },
        audioSplit:     (p.audioSplit === true),
        // Déclencheur « nouvelles séquences » : une nested créée en pleine
        // session ne doit pas entraîner le rangement de médias que
        // l'utilisateur est peut-être en train de placer.
        onlySequences:  (p.only === "sequences"),
        // Passage AUTOMATIQUE (après une Nest, un import de séquences) : il doit
        // être quasi instantané, ExtendScript fige Premiere tant qu'il tourne.
        // Mesuré dans le journal : 7 à 20 s par passage sur les projets de
        // 16 000 à 28 000 clips, une fois par minute pendant le montage. Ce
        // passage ne relit donc jamais toutes les pistes : cf. classifySequence.
        fast:           (p.only === "sequences" && p.mode !== "full"),
        // Classement bon marché (cf. classifySequence) : le passage après une
        // Nest ET les passages automatiques d'import / de minuteur quand
        // Auto-organize est allumé. Jamais le bouton, jamais le re-tri complet.
        auto:           (p.mode !== "full") && (p.only === "sequences" || p.auto === "import" ||
                        p.auto === "interval" || p.auto === "sequences"),
        // Beaucoup de monteurs se servent des étiquettes de couleur pour le
        // STATUT (validé / à revoir / VFX). Les écraser sans prévenir détruit
        // ce travail, d'où l'interrupteur côté panneau. Défaut : activé.
        useColors:      (p.colorLabels !== false),
        refreshView:    (p.refreshView !== false),
        // Chutiers à nous, par nodeId : leur catégorie, leur chemin, l'objet.
        // Le chemin est connu dès qu'on les trouve — le recalculer en
        // reparcourant tout l'arbre coûtait 20 000 appels par passage sur un
        // projet de 1 200 éléments.
        owned:          { ids: {}, list: [], cat: {}, path: {}, alias: {}, parent: {} },
        binObj:         {},                        // tout chutier créé / vidé / possédé, par nodeId
        emptied:        {},                        // chutiers qu'on a vidés (mode full)
        created:        {},                        // chutiers créés PAR CE rangement
        mergeUndo:      [],                        // déplacements faits par la fusion des doublons
        leftoverBins:   [],                        // restes d'import trouvés dans nos chutiers (chemins)
        leftoverTop:    {},                        // nodeId → chemin, pour le rapport
        leftoverDeleted: [],                       // ceux réellement supprimés
        binDepth:       {},                        // nodeId → profondeur, pour le ménage (sous-chutiers d'abord)
        userShell:      {},                        // chutiers de l'utilisateur qui menaient à un reste d'import
        userShellDeleted: [],                      // ceux que le passage a laissés vides, donc retirés
        // Anciens chutiers du plugin (« video », « other »… sans numéro) :
        // seulement si l'utilisateur l'a demandé. Sinon un « Video » à lui
        // était vidé puis supprimé au premier clic.
        legacyBins:     (p.legacyBins === true)
    };

    findOwnedBins(ctx);
    return ctx;
}

function parsePayload(json) {
    try {
        var v = JSON.parse(json);
        return (v && typeof v === "object") ? v : null;
    } catch (e) {}
    return null;
}

// moveBin() ne lève pas toujours quand Premiere refuse : selon les versions il
// renvoie un code. On traite 0 / true / undefined comme un succès, tout autre
// retour comme un échec — sinon le rapport et l'annulation mentent.
function moveOrThrow(item, dest) {
    var r = item.moveBin(dest);
    if (r === undefined || r === 0 || r === true) return;
    throw new Error("moveBin refused: " + r);
}

// Un chutier est à nous s'il porte un nom de CATÉGORIE et se trouve à la
// racine — ou s'il porte un nom de sous-chutier audio et se trouve DANS le
// chutier audio. Un « Music » ou un « Voice » que l'utilisateur aurait créé à
// la racine ne nous regarde pas : c'est cette contrainte de position qui
// protège ses chutiers, donc les noms de sous-chutiers ne sont PAS testés ici.
function findOwnedBins(ctx) {
    var catOf = {}, aliasOf = {};
    for (var k in ctx.p.names) {
        if (!ctx.p.names.hasOwnProperty(k) || !ctx.p.names[k]) continue;
        catOf[nameKey(ctx.p.names[k])] = k;
    }
    // Anciens chutiers de catégorie (liste fermée, cf. LEGACY_NAMES) : ils
    // veulent dire la même chose — leurs éléments de premier niveau rejoignent
    // le chutier numéroté, et ils disparaissent une fois vidés. Leurs
    // sous-chutiers ne sont pas touchés. Premiere les recrée quand on colle
    // depuis un vieux projet.
    for (var lc in LEGACY_NAMES) {
        if (!ctx.legacyBins || !LEGACY_NAMES.hasOwnProperty(lc)) continue;
        for (var ln = 0; ln < LEGACY_NAMES[lc].length; ln++) {
            var lk = nameKey(LEGACY_NAMES[lc][ln]);
            if (!catOf[lk]) { catOf[lk] = lc; aliasOf[lk] = true; }
        }
    }
    catOf[nameKey(REFRESH_BIN_NAME)] = "refresh";
    var rootBins = getChildren(ctx.root);
    for (var i = 0; i < rootBins.length; i++) {
        var bin = rootBins[i];
        try {
            if (bin.type !== 2) continue;
            var nm = String(bin.name);
            if (isNameIgnored(nm, ctx.ignored)) continue;
            var cat = catOf[nameKey(nm)];
            if (!cat) continue;
            adoptBin(ctx, bin, cat, [nm], null);
            if (aliasOf[nameKey(nm)]) ctx.owned.alias[idKey(bin.nodeId)] = true;
            // Sous-chutiers possédés (Music/SFX/Voice, Backups). Un passage
            // automatique ne s'occupe que des séquences : inutile de lister les
            // centaines d'éléments du chutier audio pour y chercher « SFX ».
            // Sous-chutiers possédés : Music / SFX / Voice dans l'audio. Pas
            // « Backups » dans les séquences : le plugin y DÉPOSE ses
            // sauvegardes mais n'y entre jamais — un « Backups » que
            // l'utilisateur aurait créé là est le sien. Jamais un sous-chutier
            // sur la liste « Ignorer ». Le passage automatique ne s'occupe que
            // des séquences : inutile de lister le chutier audio.
            if (!SUBS[cat] || aliasOf[nameKey(nm)] || cat === "seq" || ctx.fast) continue;
            var subs = getChildren(bin);
            for (var j = 0; j < subs.length; j++) {
                try {
                    if (subs[j].type === 2 && isSubName(cat, subs[j].name) &&
                        !isNameIgnored(subs[j].name, ctx.ignored)) {
                        adoptBin(ctx, subs[j], cat, [nm, String(subs[j].name)], bin);
                    }
                } catch (eSub) {}
            }
        } catch (e) {}
    }
}

function adoptBin(ctx, bin, cat, parts, parentBin) {
    var k = idKey(bin.nodeId);
    ctx.binObj[k] = bin;
    if (ctx.owned.ids[k]) return;
    ctx.owned.ids[k] = true;
    ctx.owned.list.push(bin);
    ctx.owned.cat[k] = cat || "";
    ctx.owned.path[k] = parts || [String(bin.name)];
    if (parentBin) ctx.owned.parent[k] = parentBin;
}

function isSubName(cat, name) {
    var subs = SUBS[cat];
    if (!subs) return false;
    for (var s in subs) {
        if (subs.hasOwnProperty(s) && sameName(name, subs[s])) return true;
    }
    return false;
}

// Prédicat de suppression après un rangement : les chutiers que CE passage a
// créés ou vidés, et le temporaire de rafraîchissement. Un chutier déjà vide
// avant nous — même nommé comme une catégorie — n'est pas à nous.
function ownedOrEmptied(ctx) {
    return function (bin) {
        var k = idKey(bin.nodeId);
        return !!ctx.created[k] || !!ctx.emptied[k] || sameName(bin.name, REFRESH_BIN_NAME);
    };
}

// =============================================================================
//  PHASE 1 — Collecte & catégorisation
// =============================================================================

// Ce qu'un rangement a le droit d'examiner. Chaque entrée : { item, parent,
// from } où `from` est le chemin de chutiers d'origine (pour l'annulation).
function collectEntries(ctx) {
    var entries = [];
    if (ctx.mode === "full") {
        collectItemsDeep(ctx.root, entries, ctx.ignored, []);
        return entries;
    }

    // Incrémental : la racine (les nouveaux imports) + le premier niveau de
    // nos propres chutiers (pour re-vérifier ce qu'on y a déposé) + ce qui
    // s'est glissé DANS nos chutiers (cf. collectInsideOwned). Rien d'autre.
    // Passage automatique : la racine + les chutiers de séquences seulement —
    // le chutier des séquences (un « Nested Sequence » ou une sauvegarde à y
    // reprendre) et les anciens chutiers sans numéro. « 08 nested sequence »
    // n'est pas relu : ce qui y est rangé y reste (cf. classifySequence). Il
    // n'ouvre aucun sous-chutier : il doit rester quasi instantané.
    collectDirect(ctx.root, entries, [], "", false, ctx);
    var owned = ctx.owned.list.slice(0);
    for (var i = 0; i < owned.length; i++) {
        var bin = owned[i];
        try {
            var k = idKey(bin.nodeId);
            var cat = ctx.owned.cat[k];
            if (cat === "refresh") continue;
            if (ctx.fast && !(cat === "seq" || (cat === "nested" && ctx.owned.alias[k]))) continue;
            var subs = ctx.fast ? null : [];
            collectDirect(bin, entries, ctx.owned.path[k], cat, !!ctx.owned.alias[k], ctx, subs);
            if (subs && subs.length && !ctx.owned.parent[k]) {
                collectInsideOwned(ctx, subs, ctx.owned.path[k], cat, entries, false, bin);
            }
        } catch (e) {}
    }
    // Les restes d'import posés DANS les chutiers de l'utilisateur (cf.
    // collectStrayBins). Pas le passage après une Nest : il reste instantané.
    if (!ctx.fast) collectStrayBins(ctx, entries);
    return entries;
}

// Ce qui s'est glissé DANS nos chutiers. Relevé sur « Client B 6 » le 30/09 :
// un import de séquences depuis un ancien projet a recréé, à l'intérieur de
// « 01 sequence », les chutiers de ce projet — « nested sequence » (2
// imbriquées), « video » (5 rushes), « music & sound effect » (3 sons). Le
// bouton Organize n'ouvrait aucun sous-chutier : des imbriquées sont restées
// au milieu des montages, et des médias dans le chutier des séquences.
//   · Un sous-chutier qui porte un nom de chutier du plugin (une catégorie ou
//     un ancien nom : « nested sequence », « video »…) est un reste d'import :
//     tout ce qu'il contient, à toute profondeur, est rangé comme un nouvel
//     import, et il disparaît une fois vide.
//   · Les autres sous-chutiers de « 01 sequence » / « 08 nested sequence »
//     sont un rangement de l'utilisateur (« 01 sequence/9-29 V1 ») : une
//     séquence du bon genre y reste ; une imbriquée sous 01 part dans 08, un
//     montage sous 08 part dans 01, un média en sort.
//   · Les sous-chutiers des chutiers de médias (« 03 b-roll/Cuisine ») ne
//     sont pas ouverts : c'est le rangement de l'utilisateur.
// Jamais un sous-chutier « Ignorer », jamais « Backups » (le plugin y dépose
// les sauvegardes sans y entrer), jamais Music / SFX / Voice (déjà lus).
function collectInsideOwned(ctx, subs, parts, topCat, entries, leftover, parentBin) {
    for (var i = 0; i < subs.length; i++) {
        try {
            var sub = subs[i].bin, nm = subs[i].name;
            if (isNameIgnored(nm, ctx.ignored)) continue;
            var k = idKey(sub.nodeId);
            if (ctx.owned.ids[k]) continue;
            if (!leftover && parts.length === 1 && isSubName(topCat, nm)) continue;
            var isLeftover = leftover || isPluginBinName(ctx, nm);
            if (!isLeftover && topCat !== "seq" && topCat !== "nested") continue;
            var here = parts.concat([nm]);
            if (isLeftover) {
                ownForCleanup(ctx, sub, here, parentBin);
                if (!leftover && ctx.leftoverBins.length < 50) {
                    ctx.leftoverBins.push(here.join("/"));
                    ctx.leftoverTop[k] = here.join("/");
                }
            }
            var start = entries.length, below = [];
            collectDirect(sub, entries, here, isLeftover ? "" : topCat, false, ctx, below);
            for (var e = start; e < entries.length; e++) {
                entries[e].inSub = true;
                entries[e].topCat = topCat;
                entries[e].leftover = isLeftover;
            }
            if (below.length) collectInsideOwned(ctx, below, here, topCat, entries, isLeftover, sub);
        } catch (eSub) {}
    }
}

// Un nom de chutier du plugin : une catégorie (« 08 nested sequence ») ou un
// ancien nom (LEGACY_NAMES). Ne sert qu'à reconnaître un reste d'import DANS
// nos chutiers — jamais à s'approprier un chutier de l'utilisateur.
function isPluginBinName(ctx, nm) {
    for (var c in ctx.p.names) {
        if (ctx.p.names.hasOwnProperty(c) && ctx.p.names[c] && sameName(nm, ctx.p.names[c])) return true;
    }
    for (var lc in LEGACY_NAMES) {
        if (!ctx.legacyBins || !LEGACY_NAMES.hasOwnProperty(lc)) continue;
        for (var j = 0; j < LEGACY_NAMES[lc].length; j++) {
            if (sameName(nm, LEGACY_NAMES[lc][j])) return true;
        }
    }
    return false;
}

// Les chutiers du plugin qu'un import a déposés DANS les chutiers de
// l'utilisateur. Relevé sur « Client B 6 » le 07/10 : chaque jour, les
// séquences d'un projet « Sources … » sont importées ; Premiere recrée alors,
// sous « 02 rushes & nests (jours)/Sources 10-4 », les chutiers de ce projet
// (« video », « nested sequence », « music & sound effect », « screenshots »,
// « 00 offline »…). Le bouton n'ouvrait jamais les chutiers de
// l'utilisateur : 47 chutiers en double, 132 éléments éparpillés, et le
// rapport disait « tout est déjà rangé ».
//   · Un chutier qui porte un nom du plugin (une catégorie, ou un ancien nom
//     si « Merge old bins » est allumé), à n'importe quelle profondeur sous un
//     chutier de l'utilisateur, est un reste d'import : tout ce qu'il
//     contient est rangé comme un nouvel import, et il disparaît une fois vide.
//   · Le reste ne bouge pas : ni « Rushes 10-1 », ni les séquences posées
//     directement dans « Sources 10-4 ».
//   · Un chutier de l'utilisateur qui ne menait QU'À de tels restes, et que ce
//     passage laisse vide, part aussi (cascade de deleteEmptyKnownBins). Vide
//     avant le passage, ou rempli d'autre chose : il reste.
// Jamais un chutier « Ignorer » (ni ce qu'il contient), jamais le temporaire
// de rafraîchissement. Les sous-chutiers des chutiers du plugin sont l'affaire
// de collectInsideOwned.
function collectStrayBins(ctx, entries) {
    var top = getChildren(ctx.root);
    for (var i = 0; i < top.length; i++) {
        try {
            var b = top[i];
            if (b.type !== 2) continue;
            if (ctx.owned.ids[idKey(b.nodeId)]) continue;
            var nm = String(b.name);
            if (nm === REFRESH_BIN_NAME || isNameIgnored(nm, ctx.ignored)) continue;
            walkUserBin(ctx, b, [nm], null, entries);
        } catch (e) {}
    }
}

// Descend dans un chutier de l'utilisateur ; renvoie true s'il mène à au
// moins un reste d'import. Une seule lecture de `children` par chutier.
function walkUserBin(ctx, bin, parts, parentBin, entries) {
    if (parts.length > 20) return false;
    var ch = getChildren(bin), found = false;
    for (var i = 0; i < ch.length; i++) {
        try {
            if (ch[i].type !== 2) continue;
            var nm = String(ch[i].name);
            if (nm === REFRESH_BIN_NAME || isNameIgnored(nm, ctx.ignored)) continue;
            var here = parts.concat([nm]);
            if (!isPluginBinName(ctx, nm)) {
                if (walkUserBin(ctx, ch[i], here, bin, entries)) found = true;
                continue;
            }
            found = true;
            var k = idKey(ch[i].nodeId);
            ownForCleanup(ctx, ch[i], here, bin);
            ctx.binDepth[k] = here.length;
            if (ctx.leftoverBins.length < 50) {
                ctx.leftoverBins.push(here.join("/"));
                ctx.leftoverTop[k] = here.join("/");
            }
            var start = entries.length, below = [];
            collectDirect(ch[i], entries, here, "", false, ctx, below);
            for (var e = start; e < entries.length; e++) {
                entries[e].inSub = true;
                entries[e].topCat = "";
                entries[e].leftover = true;
            }
            if (below.length) collectInsideOwned(ctx, below, here, "", entries, true, ch[i]);
        } catch (eB) {}
    }
    // Connu du ménage, pour partir s'il se retrouve vide après le passage.
    if (found) {
        var bk = idKey(bin.nodeId);
        ctx.binObj[bk] = bin;
        ctx.binDepth[bk] = parts.length;
        ctx.userShell[bk] = parts.join("/");
        if (parentBin) ctx.owned.parent[bk] = parentBin;
    }
    return found;
}

// Un reste d'import dans nos chutiers : à nous pour le ménage — supprimé
// s'il a été vidé par ce passage —, sans devenir un chutier de catégorie (rien
// n'y est jamais déposé). Un sous-chutier déjà vide reste : il a peut-être été
// préparé à la main.
function ownForCleanup(ctx, bin, parts, parentBin) {
    var k = idKey(bin.nodeId);
    ctx.binObj[k] = bin;
    if (ctx.owned.ids[k]) return;
    ctx.owned.ids[k] = true;
    ctx.owned.cat[k] = "";
    ctx.owned.path[k] = parts;
    ctx.owned.parent[k] = parentBin;
}

// `subsOut` (facultatif) reçoit les sous-chutiers rencontrés, { bin, name } :
// une seule lecture de `children` par chutier, même quand on descend.
function collectDirect(parent, result, parts, binCat, binAlias, ctx, subsOut) {
    var ch = getChildren(parent);
    for (var i = 0; i < ch.length; i++) {
        try {
            if (ch[i].type === 2) {
                var bn = String(ch[i].name);
                // Un temporaire de rafraîchissement resté là (sa suppression a
                // échoué) : on le note, le nettoyage ciblé le ramassera.
                if (ctx && bn === REFRESH_BIN_NAME) {
                    ctx.binObj[idKey(ch[i].nodeId)] = ch[i];
                    ctx.created[idKey(ch[i].nodeId)] = true;
                } else if (subsOut) {
                    subsOut.push({ bin: ch[i], name: bn });
                }
                continue;
            }
            var e = entryFor(ch[i], parent, parts);
            e.binCat = binCat || "";           // catégorie du chutier d'origine, "" = racine
            e.binAlias = !!binAlias;           // ancien chutier (sans numéro) de cette catégorie
            result.push(e);
        } catch (e2) {}
    }
}

// Une entrée porte son origine deux fois : en segments (fiable, pour
// l'annulation — un nom de chutier peut contenir « / ») et en chaîne (pour
// comparer avec la destination).
function entryFor(item, parent, parts) {
    return { item: item, parent: parent, fromParts: parts, from: parts.join("/") };
}

// Segments du chemin d'un chutier, à n'importe quelle profondeur :
// « 04 music & sound effect » / « SFX ». Vide = la racine.
function binPathOf(root, bin) {
    if (!bin || bin.nodeId === root.nodeId) return [];
    var found = null;
    function walk(parent, parts) {
        var ch = getChildren(parent);
        for (var i = 0; i < ch.length && !found; i++) {
            if (ch[i].type !== 2) continue;
            var here = parts.concat([String(ch[i].name)]);
            if (ch[i].nodeId === bin.nodeId) { found = here; return; }
            walk(ch[i], here);
        }
    }
    walk(root, []);
    return found || [String(bin.name)];
}

function buildPlan(ctx) {
    var plan = { cats: {}, dupNames: [], nestedScan: null, seqDecisions: [], unusedNested: [] };
    for (var c = 0; c < CAT_ORDER.length; c++) plan.cats[CAT_ORDER[c]] = [];

    var entries  = collectEntries(ctx);
    var pathSeen = {};
    var driveCache = {};
    plan.driveMissing = {};
    // Ce que l'on sait de l'usage des séquences, calculé au plus tard et au
    // moins cher possible : cf. classifySequence.
    var usage = { full: null, active: null, plan: plan, unfiledUnnamed: 0 };
    var seqEntries = [];
    plan.keptSeqs = [];

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var item  = entry.item;
        try {
            if (isNameIgnored(item.name, ctx.ignored)) continue;
            if (ctx.onlySequences && !isSequenceItem(item)) continue;

            // Vraies séquences uniquement : isSequence() renvoie aussi true
            // pour les clips fusionnés (merged) → on les exclut.
            //
            // Sans filtre sur item.type : le type d'un élément séquence n'est
            // pas garanti valoir CLIP (1). La branche « autres types » plus bas
            // le dit déjà pour les styles et les presets — Premiere renvoie des
            // valeurs que la doc ne liste pas. Une séquence non reconnue ici
            // tombait dans « autres » (pas de chemin média → extension vide).
            if (isSequenceItem(item)) {
                // Classées après la boucle : le passage automatique doit savoir
                // combien de séquences non nommées attendent (cf. classifySequence).
                entry.seqName = String(item.name);
                seqEntries.push(entry);
                continue;
            }

            // CLIP (1) et FILE (4) : routage par extension
            if (item.type === 1 || item.type === 4) {
                // getMediaPath() est un aller-retour vers l'hôte : une seule fois.
                var mp = "";
                try { mp = item.getMediaPath(); } catch (eDup) {}
                var mpNorm = mp ? String(mp).replace(/\\/g, "/") : "";
                var fname  = mpNorm ? mpNorm.split("/").pop() : "";
                var merged = isMerged(item);

                // Détection des doublons. Un clip fusionné partage le chemin de
                // sa source vidéo : le compter reviendrait à signaler comme
                // doublon un fichier pourtant importé une seule fois.
                if (mp && mp.length > 0 && !merged) {
                    var dupKey = mp.toLowerCase();
                    if (pathSeen[dupKey]) {
                        pathSeen[dupKey]++;
                        if (pathSeen[dupKey] === 2) {
                            plan.dupNames.push(fname.length > 0 ? fname : String(item.name));
                        }
                    } else {
                        pathSeen[dupKey] = 1;
                    }
                }

                // Médias hors-ligne regroupés pour être repérés d'un coup d'œil —
                // sauf s'ils sont sur un DISQUE DÉBRANCHÉ : ils ne sont pas
                // perdus, ils attendent. Mesuré sur 11 projets réels : un Ssd
                // débranché aurait envoyé 257 à 537 éléments par projet dans
                // « 00 offline », puis les aurait renvoyés au rebranchement.
                if (isItemOffline(item)) {
                    var gone = unpluggedDrive(mpNorm, driveCache);
                    if (gone) {
                        plan.driveMissing[gone] = (plan.driveMissing[gone] || 0) + 1;
                        continue;
                    }
                    plan.cats.offline.push(entry);
                    continue;
                }

                // Exports / rendus réimportés : reconnus à leur DOSSIER, quel que
                // soit le type de fichier. Avant l'extension, sinon un rendu .mp4
                // repart au milieu des rushes.
                if (mpNorm && matchesPathPattern(mpNorm, ctx.exportPatterns)) {
                    plan.cats.exports.push(entry);
                    continue;
                }

                var ext = getExtFrom(fname, item.name);

                // Un clip fusionné (vidéo + son enregistré à part) n'a pas
                // toujours de chemin média exploitable. Sans ce cas il tombait
                // dans « autres », alors que c'est précisément l'A-roll d'un
                // tournage en double système.
                if (merged && !isVideo(ext)) {
                    plan.cats.video.push(entry);
                    continue;
                }

                if (isVideo(ext)) {
                    var near = nearestFolderKind(mpNorm);
                    if (near === "music") {
                        // Un morceau téléchargé en .mp4 (« THANK YOU - INSTRUMENTAL -
                        // Tyler, The Creator.mp4 » dans « Musique/ ») est une musique.
                        entry.sub = ctx.audioSplit ? "music" : null;
                        plan.cats.audio.push(entry);
                    } else if (SFX_WORD_RE.test(fname.toLowerCase())) {
                        // « BLADE WHOOSH SFX.mp4 » : un effet sonore, livré en vidéo.
                        entry.sub = ctx.audioSplit ? "sfx" : null;
                        plan.cats.audio.push(entry);
                    } else if (matchesBrollName(fname, item.name, mpNorm, ctx.brollPatterns) ||
                               looksLikeSocialName(fname, item.name) || near === "broll") {
                        plan.cats.broll.push(entry);
                    } else {
                        plan.cats.video.push(entry);
                    }
                }
                else if (isAudio(ext)) {
                    entry.sub = ctx.audioSplit ? audioSubFor(fname, item.name, mpNorm, ctx) : null;
                    plan.cats.audio.push(entry);
                }
                else if (isImage(ext)) plan.cats.images.push(entry);
                else if (isAnim(ext))  plan.cats.anim.push(entry);
                else if (isStyle(ext)) plan.cats.styles.push(entry);
                else                   plan.cats.other.push(entry);
                continue;
            }

            // Tout autre type (presets Premiere, styles typographiques, etc.)
            //
            // NE PAS rerouter vers « autres » : une analyse statique conclut
            // que cette branche est inatteignable (types 1 et 4 sont partis
            // plus haut, type 2 n'est jamais collecté), mais c'est faux sur le
            // terrain — Premiere renvoie d'autres valeurs de type pour les
            // styles de texte et les presets, et ils atterrissent bien ici.
            if (item.type !== 2 && item.type !== 4) {
                plan.cats.styles.push(entry);
            }
        } catch (e) {}
    }

    classifySequences(ctx, plan, seqEntries, usage);
    return plan;
}

function classifySequences(ctx, plan, seqEntries, usage) {
    var i;
    for (i = 0; i < seqEntries.length; i++) {
        var se = seqEntries[i];
        var filedHere = filedAs(se) !== "";
        // Une séquence que le nom suffit à classer (Premiere, AutoCut, ou une
        // règle de l'utilisateur) ne compte pas dans l'arriéré à juger.
        if (!looksNestedByName(se.seqName) && !BACKUP_NAME_RE.test(se.seqName) &&
            !ruleVerdict(ctx, se.seqName) && !filedHere) {
            usage.unfiledUnnamed++;
        }
    }
    plan.byRule = 0;
    var named = [];
    for (i = 0; i < seqEntries.length; i++) {
        var entry = seqEntries[i];
        try {
            var d = classifySequence(ctx, entry, usage);
            // Chaque décision est gardée dans le rapport : quand le tri se
            // trompe, c'est la seule façon de voir POURQUOI sans le projet.
            if (plan.seqDecisions.length < 300) {
                plan.seqDecisions.push({
                    name: entry.seqName, from: entry.from, nested: d.nested ? 1 : 0,
                    why: d.why, used: d.used, sub: d.sub || "", keep: d.keep ? 1 : 0
                });
            }
            if (d.keep) {
                if (plan.keptSeqs.length < 300) plan.keptSeqs.push(entry.seqName);
                continue;
            }
            if (d.sub) entry.sub = d.sub;
            plan.cats[d.nested ? "nested" : "seq"].push(entry);
            if (d.why === "name") named.push(entry);
            if (d.why === "rule") plan.byRule++;
        } catch (e) {}
    }
    // Les restes (« Nested Sequence » utilisée nulle part) sont signalés, jamais
    // supprimés — et seulement quand un contrôle complet a eu lieu de toute
    // façon : on ne relit pas 28 000 clips juste pour une ligne de rapport.
    if (usage.full) {
        for (i = 0; i < named.length && plan.unusedNested.length < 300; i++) {
            try {
                if (!isNestedSeq(named[i].item, usage.full)) plan.unusedNested.push(named[i].seqName);
            } catch (e2) {}
        }
    }
}

function scanSummary(nested) {
    var ids = [], names = [];
    if (!nested) return null;
    for (var k in nested.byId) if (nested.byId.hasOwnProperty(k) && ids.length < 300) ids.push(k.substring(2));
    for (var n in nested.byName) if (nested.byName.hasOwnProperty(n) && names.length < 300) names.push(n.substring(2));
    return {
        mode: nested.mode, seqCount: nested.seqCount, tracksSeen: nested.tracksSeen, clipsSeen: nested.clipsSeen,
        nestedFound: nested.nestedFound, opened: nested.opened, errors: nested.errors,
        idsInTimelines: ids, namesInTimelines: names
    };
}

function seqTotal() {
    try { return app.project.sequences.numSequences; } catch (e) { return -1; }
}

// =============================================================================
//  CLASSEMENT D'UNE SÉQUENCE
//
//  Règle (celle de l'utilisateur, mesurée sur ses projets) : une séquence est
//  imbriquée si elle est utilisée dans une autre timeline OU si elle porte le
//  nom que Premiere donne à une imbrication. Le NOM se lit en un appel ;
//  l'USAGE exige de relire les pistes — sur un projet de 28 000 clips, 170 000
//  appels, 7 à 20 s de Premiere figé. Du moins cher au plus cher :
//
//    1. le nom : « Nested Sequence 42 » → imbriquée ; une sauvegarde AutoCut /
//       AutoPod → « 01 sequence/Backups ». Aucune piste lue.
//    2. bouton Organize, Preview : toutes les timelines, lues une seule fois.
//    3. passage automatique (après une Nest, un import) :
//       - déjà dans « 08 nested sequence » : y reste ;
//       - utilisée dans la timeline ACTIVE → imbriquée. C'est là qu'on vient
//         de glisser un hook dans son assemblage, ou d'imbriquer puis de
//         renommer. Vaut aussi pour ce qui est déjà dans « 01 sequence » ;
//       - déjà dans « 01 sequence », absente de la timeline active : y reste ;
//       - pas encore rangée, absente de la timeline active : si c'est la
//         seule séquence dans ce cas, c'est un nouveau montage (« 9/30 ») →
//         « 01 sequence ». S'il y en a plusieurs, c'est un arriéré qu'on ne
//         sait pas juger sans tout relire : elles restent où elles sont
//         jusqu'au prochain Organize. Deviner rangeait des imbriquées
//         renommées (« e », « ` ») parmi les montages.
//
//  Renvoie { nested, why, used, sub, keep }. `used` vaut true/false quand on
//  le sait, null sinon ; `keep` = ne pas bouger.
// =============================================================================

// Où une séquence est déjà rangée, aux yeux du passage automatique :
// « nested » dans « 08 nested sequence » ou l'ancien « nested sequence » (ce
// qu'on y trouve, ce sont des imbriquées) ; « seq » dans « 01 sequence ». Pas
// l'ancien « sequence » : une séquence qui y dort a pu être utilisée depuis
// (Client C ads : « n », utilisée dans « New ads »).
function filedAs(entry) {
    if (entry.binCat === "nested") return "nested";
    if (entry.binCat === "seq" && !entry.binAlias) return "seq";
    return "";
}

function classifySequence(ctx, entry, usage) {
    var item = entry.item;
    var name = entry.seqName !== undefined ? entry.seqName : String(item.name);
    var d = { nested: false, why: "", used: null, sub: "", keep: false };

    if (looksNestedByName(name)) {
        d.nested = true;
        d.why = "name";
        return d;
    }
    if (BACKUP_NAME_RE.test(name)) {
        d.why = "backup";
        d.sub = "backup";
        return d;
    }
    var rule = ruleVerdict(ctx, name);
    if (rule) {
        d.nested = (rule === "nested");
        d.why = "rule";
        return d;
    }
    if (!ctx.auto) {
        d.used = isNestedSeq(item, fullUsage(usage));
        d.nested = d.used;
        d.why = d.used ? "used" : "";
        return d;
    }

    var filed = filedAs(entry);
    if (filed === "nested") {
        d.nested = true;
        d.why = "filed";
        return d;
    }
    if (isNestedSeq(item, activeUsage(usage))) {
        d.nested = true;
        d.used = true;
        d.why = "active";
        return d;
    }
    if (filed === "seq") {
        d.why = "filed";
        return d;
    }
    if (usage.unfiledUnnamed > 1) {
        d.keep = true;
        d.why = "unknown";
        return d;
    }
    d.why = "new";
    return d;
}

function fullUsage(usage) {
    if (!usage.full) {
        usage.full = getNestedInfo({ activeOnly: false });
        usage.plan.nestedScan = scanSummary(usage.full);
    }
    return usage.full;
}

function activeUsage(usage) {
    if (!usage.active) {
        usage.active = getNestedInfo({ activeOnly: true });
        if (!usage.plan.nestedScan) usage.plan.nestedScan = scanSummary(usage.active);
    }
    return usage.active;
}

// Nom du sous-chutier d'une entrée, "" s'il n'y en a pas ou s'il est sur la
// liste « Ignorer » (l'entrée va alors au premier niveau de sa catégorie).
function subNameFor(ctx, cat, sub) {
    if (!sub || !SUBS[cat] || !SUBS[cat][sub]) return "";
    var nm = SUBS[cat][sub];
    return isNameIgnored(nm, ctx.ignored) ? "" : nm;
}

// Chemin de destination d'une entrée, pour savoir si elle y est déjà.
function destPathFor(ctx, entry, cat) {
    var base = String(ctx.p.names[cat]);
    var sub = subNameFor(ctx, cat, entry.sub);
    return sub ? base + "/" + sub : base;
}

function alreadyThere(ctx, entry, cat) {
    // Dans un sous-chutier de SA catégorie (« 01 sequence/9-29 V1 » pour un
    // montage) : le rangement de l'utilisateur, on n'y touche pas.
    if (entry.inSub && !entry.leftover && entry.topCat === cat) return true;
    return sameName(entry.from, destPathFor(ctx, entry, cat));
}

// =============================================================================
//  PHASE 2 — Création des chutiers + déplacement + couleurs
// =============================================================================

function applyPlan(ctx, plan) {
    var report = {
        ok: true, mode: ctx.mode, project: "",
        counts: {}, total: 0, unchanged: 0,
        duplicates: plan.dupNames,
        failed: 0,        // éléments qu'on n'a pas réussi à déplacer
        failedNames: [],  // …et lesquels (10 premiers)
        skipped: [],      // catégories volontairement laissées de côté
        undo: { items: [], bins: [], names: ctx.p.names, project: "" },
        debug: { version: VERSION, nestedScan: plan.nestedScan, seqDecisions: plan.seqDecisions },
        unusedNested: plan.unusedNested,
        onlySequences: ctx.onlySequences,
        seqTotal: seqTotal(),
        nestedFound: plan.cats.nested.length,
        scan: plan.nestedScan ? plan.nestedScan.mode : "none",
        clipsRead: plan.nestedScan ? plan.nestedScan.clipsSeen : 0,
        driveMissing: plan.driveMissing || {},
        keptSeqs: plan.keptSeqs || [],
        leftoverBins: ctx.leftoverBins,
        byRule: plan.byRule || 0
    };
    try { report.project = String(app.project.path); } catch (eP) {}
    report.undo.project = report.project;

    for (var c = 0; c < CAT_ORDER.length; c++) {
        var cat = CAT_ORDER[c];
        var entries = plan.cats[cat];
        if (!entries || entries.length === 0) continue; // ← PAS de chutier créé si vide

        // Nom de catégorie listé dans « Ignorer » : on ne crée rien et on ne
        // déplace rien. Sinon on déposerait des éléments dans un chutier
        // qu'on a justement promis de ne pas toucher.
        var binName = ctx.p.names[cat];
        if (!binName || isNameIgnored(binName, ctx.ignored)) {
            report.skipped.push(String(binName || cat));
            continue;
        }

        // Rien à faire pour cette catégorie ? Alors pas de chutier non plus.
        var pending = [];
        for (var k = 0; k < entries.length; k++) {
            if (alreadyThere(ctx, entries[k], cat)) report.unchanged++;
            else pending.push(entries[k]);
        }
        if (pending.length === 0) continue;

        // Une catégorie qui casse ne doit pas emporter le rapport des autres —
        // ni surtout l'instantané d'annulation de ce qui a déjà bougé.
        try {
            applyCategory(ctx, plan, report, cat, binName, pending);
        } catch (eCat) {
            report.failed += pending.length;
        }
    }

    // Les déplacements de la fusion des doublons (mode full) d'abord : un
    // élément noté deux fois finit là où sa DERNIÈRE note l'envoie, c'est-à-dire
    // là où le plan l'avait trouvé — la bonne réponse dans les deux cas.
    if (ctx.mergeUndo.length) report.undo.items = ctx.mergeUndo.concat(report.undo.items);

    // En mode incrémental, seuls NOS chutiers peuvent avoir été vidés (on n'a
    // collecté nulle part ailleurs) — on ne garde que ceux-là, pour que la
    // protection des chutiers de l'utilisateur ne dépende pas de ce raisonnement.
    if (ctx.mode !== "full") {
        var kept = {};
        for (var e in ctx.emptied) {
            if (ctx.emptied.hasOwnProperty(e) && ctx.owned.ids[e]) kept[e] = true;
        }
        ctx.emptied = kept;
    }

    return report;
}

function applyCategory(ctx, plan, report, cat, binName, pending) {
        var bin = findOrMergeBin(binName, ctx.root, ctx.ignored, ctx.mode === "full", ctx);
        if (!bin) {                    // création refusée par Premiere
            report.failed += pending.length;
            return;
        }
        adoptBin(ctx, bin, cat, [String(binName)], null);
        // Seuls les chutiers CRÉÉS par ce rangement partent à l'annulation. Un
        // « 02 video » que l'utilisateur avait déjà, même vide, lui appartient.
        if (ctx.created[idKey(bin.nodeId)]) report.undo.bins.push(String(bin.nodeId));

        if (ctx.useColors && CAT_COLORS[cat] !== undefined) {
            try { bin.setColorLabel(CAT_COLORS[cat]); } catch (e) {}
        }

        // On compte les déplacements RÉUSSIS, pas les tentatives : un rapport
        // qui annonce 500 éléments rangés alors que 50 ont échoué est pire
        // que pas de rapport du tout.
        var moved = 0;
        var touchedBins = {};
        for (var i = 0; i < pending.length; i++) {
            var entry  = pending[i];
            var target = bin;
            try {
                var subName = subNameFor(ctx, cat, entry.sub);
                if (subName) {
                    // Un seul aller-retour vers l'hôte par sous-chutier, pas un par clip.
                    if (!touchedBins[entry.sub]) {
                        touchedBins[entry.sub] = findChildBin(bin, subName, true, ctx) || bin;
                        var sub = touchedBins[entry.sub];
                        if (sub.nodeId !== bin.nodeId) {
                            adoptBin(ctx, sub, cat, [String(binName), String(subName)], bin);
                            if (ctx.created[idKey(sub.nodeId)]) report.undo.bins.push(String(sub.nodeId));
                            if (ctx.useColors && CAT_COLORS[cat] !== undefined) {
                                try { sub.setColorLabel(CAT_COLORS[cat]); } catch (eC) {}
                            }
                        }
                    }
                    target = touchedBins[entry.sub];
                }

                moveOrThrow(entry.item, target);
                moved++;
                // L'annulation retrouve le chutier d'origine par son nodeId
                // (deux chutiers « 02 video » / « 02 Video » ne se confondent
                // plus), et remet l'étiquette de couleur d'avant.
                var undoEntry = { id: String(entry.item.nodeId), from: entry.from, fromParts: entry.fromParts };
                report.undo.items.push(undoEntry);
                if (entry.parent && entry.parent.nodeId !== ctx.root.nodeId) {
                    undoEntry.fromId = String(entry.parent.nodeId);
                    ctx.emptied[idKey(entry.parent.nodeId)] = true;
                    ctx.binObj[idKey(entry.parent.nodeId)] = entry.parent;
                }
                if (ctx.useColors && CAT_COLORS[cat] !== undefined) {
                    try {
                        var prevLabel = entry.item.getColorLabel();
                        if (typeof prevLabel === "number") undoEntry.label = prevLabel;
                    } catch (eL) {}
                    try { entry.item.setColorLabel(CAT_COLORS[cat]); } catch (e) {}
                }
            } catch (e) {
                if (report.failedNames.length < 10) {
                    try { report.failedNames.push(String(entry.item.name)); } catch (eN) {}
                }
            }
        }

        report.failed += (pending.length - moved);
        if (moved > 0) {
            report.counts[cat] = moved;
            report.total += moved;
            // Forcer le panneau à recalculer la grille de CE chutier, sinon
            // les vignettes qu'on vient d'y déposer restent empilées.
            if (ctx.refreshView) nudgeBinLayout(bin);
        }
}

// =============================================================================
//  PHASE 3 — Suppression réelle des chutiers vides
//  deleteBin() supprime un chutier ET son contenu → on ne l'appelle QUE sur
//  des chutiers vides (children.numItems === 0), en post-ordre (enfants
//  d'abord), et seulement si `canDelete(bin)` l'autorise : nos chutiers, ceux
//  qu'on vient de vider. Un chutier vide préparé par l'utilisateur reste.
// =============================================================================

function deleteEmptyBins(root, ignoredBins, canDelete, noCascade) {
    // Renvoie le nombre de chutiers « de structure » supprimés sous `parent`
    // (hors temporaire de rafraîchissement). Un parent qui ne contenait QUE
    // des chutiers qu'on vient de supprimer a été vidé par nous : il part
    // aussi. Le temporaire ne déclenche pas cette cascade, sinon un chutier
    // de catégorie vide mais pré-existant pourrait y passer.
    function pass(parent) {
        var removed = 0;
        var ch = getChildren(parent);
        for (var i = 0; i < ch.length; i++) {
            // Chaque accès à l'hôte est protégé, comme dans les autres
            // parcours : après un deleteBin(), les références voisines du
            // tableau figé peuvent être périmées et lever au premier accès.
            try {
                var item = ch[i];
                if (item.type !== 2) continue;
                if (isNameIgnored(item.name, ignoredBins)) continue;
                var below = pass(item);
                var isRefresh = sameName(item.name, REFRESH_BIN_NAME);
                if (item.children.numItems === 0 && (canDelete(item) || (!noCascade && below > 0))) {
                    try {
                        item.deleteBin();
                        if (!isRefresh) removed++;
                    } catch (e) {}
                }
            } catch (e) {}
        }
        return removed;
    }
    // pass() est déjà en post-ordre : une passe suffit dans le cas normal.
    // La seconde rattrape les bins devenus vides après un sous-bin sauté.
    pass(root);
    pass(root);
}

// Nettoyage ciblé : les chutiers créés, vidés ou possédés par ce passage,
// sous-chutiers d'abord. Mêmes règles que deleteEmptyBins : vide ET créé ou
// vidé par nous ; un parent qui ne contenait que des chutiers supprimés ici
// part aussi. Jamais un chutier sur la liste « Ignorer ».
function deleteEmptyKnownBins(ctx) {
    var canDelete = ownedOrEmptied(ctx);
    var list = [];
    for (var k in ctx.binObj) {
        if (!ctx.binObj.hasOwnProperty(k)) continue;
        list.push({ k: k, bin: ctx.binObj[k], depth: ctx.binDepth[k] || (ctx.owned.path[k] || [1]).length });
    }
    list.sort(function (a, b) { return b.depth - a.depth; });
    var cascade = {};
    for (var i = 0; i < list.length; i++) {
        try {
            var b = list[i].bin;
            if (b.nodeId === ctx.root.nodeId) continue;
            if (isNameIgnored(b.name, ctx.ignored)) continue;
            if (b.children.numItems !== 0) continue;
            if (!canDelete(b) && !cascade[list[i].k]) continue;
            var parent = ctx.owned.parent[list[i].k];
            b.deleteBin();
            if (ctx.leftoverTop[list[i].k]) ctx.leftoverDeleted.push(ctx.leftoverTop[list[i].k]);
            if (ctx.userShell[list[i].k]) ctx.userShellDeleted.push(ctx.userShell[list[i].k]);
            // Un sous-chutier créé ET resté vide dans ce passage ne rend pas
            // son parent supprimable : le parent était peut-être vide AVANT.
            if (parent && !ctx.created[list[i].k]) cascade[idKey(parent.nodeId)] = true;
        } catch (e) {}
    }
}

// =============================================================================
//  RAFRAÎCHISSEMENT DE LA VUE
//
//  Le panneau Projet ne recalcule pas sa grille en vue Icônes après un
//  rangement fait par script : les vignettes restent empilées les unes sur les
//  autres jusqu'à ce que l'utilisateur déplace un élément à la main ou
//  redimensionne le panneau.
//
//  Aucune API ExtendScript n'expose de rafraîchissement — vérifié contre la
//  liste officielle des méthodes Adobe. Le seul levier disponible est de faire
//  VARIER le contenu du chutier, ce que le panneau est bien obligé de
//  refléter : on crée un sous-chutier temporaire et on le supprime aussitôt.
//  Si la suppression échoue, deleteEmptyBins() le ramasse au passage suivant.
// =============================================================================

function nudgeBinLayout(bin) {
    try {
        var tmp = bin.createBin(REFRESH_BIN_NAME);
        // Paranoïa : deleteBin() supprime un chutier ET tout son contenu.
        // On ne l'appelle que si on est certain d'être sur le temporaire.
        if (tmp &&
            tmp.nodeId !== bin.nodeId &&
            String(tmp.name) === REFRESH_BIN_NAME &&
            tmp.children.numItems === 0) {
            tmp.deleteBin();
        }
    } catch (e) {}
}

// =============================================================================
//  HELPERS — Chutiers
// =============================================================================

// Le chutier de catégorie `name`, créé s'il manque.
//   deep = false : on ne regarde qu'à la racine (incrémental, pont Pinterest).
//   deep = true  : on fouille tout l'arbre, on promeut à la racine et on
//                  fusionne les doublons (mode full, comportement historique).
function findOrMergeBin(name, root, ignored, deep, ctx) {
    var allFound = [];
    if (deep) findBinsDeep(root, name, allFound, ignored);
    else {
        var rootBins = getChildren(root);
        for (var r = 0; r < rootBins.length; r++) {
            if (rootBins[r].type === 2 && sameName(rootBins[r].name, name) &&
                !isNameIgnored(rootBins[r].name, ignored)) {
                allFound.push(rootBins[r]);
            }
        }
    }

    if (allFound.length === 0) {
        try {
            var made = root.createBin(name);
            if (made && ctx) { ctx.created[idKey(made.nodeId)] = true; ctx.binObj[idKey(made.nodeId)] = made; }
            return made;
        } catch (e) { return null; }
    }

    // Chercher un chutier déjà à la racine comme canonical (comparaison par
    // nodeId : l'égalité de référence n'est pas fiable en ExtendScript)
    var canonical = null;
    var rootChildren = getChildren(root);
    for (var i = 0; i < allFound.length && !canonical; i++) {
        for (var j = 0; j < rootChildren.length; j++) {
            if (rootChildren[j].nodeId === allFound[i].nodeId) {
                canonical = allFound[i];
                break;
            }
        }
    }
    if (!canonical) {
        // Aucun chutier de ce nom à la racine : promouvoir le premier trouvé
        // pour que les catégories restent toujours au premier niveau. Le
        // parent qu'on vide ainsi est noté comme vidé par nous.
        canonical = allFound[0];
        try {
            var formerParent = parentBinOf(root, canonical);
            if (ctx) ctx.mergeUndo.push({ id: String(canonical.nodeId), fromParts: parentPathOf(root, canonical) });
            moveOrThrow(canonical, root);
            if (ctx && formerParent && formerParent.nodeId !== root.nodeId) {
                ctx.emptied[idKey(formerParent.nodeId)] = true;
            }
        } catch (e) {}
    }

    // Hors mode full, on ne fusionne pas : deux « 02 video » à la racine sont
    // un état bancal, mais les réunir déplacerait des sous-chutiers de
    // l'utilisateur sans qu'une annulation par chemin puisse les distinguer.
    if (!deep) return canonical;

    // Fusionner les doublons dans canonical. Ils seront supprimés une fois
    // vides — on les note comme vidés par nous, sinon la protection des
    // chutiers utilisateur les garderait. Chaque déplacement est noté pour
    // l'annulation : un sous-chutier déplacé ici n'est jamais une entrée du
    // plan, il ne serait sinon jamais remis. Un chutier « Ignorer » ne bouge
    // pas, ce qui garde son parent en vie.
    for (var m = 0; m < allFound.length; m++) {
        if (allFound[m].nodeId === canonical.nodeId) continue;
        var fromParts = binPathOf(root, allFound[m]);
        var kids = getChildren(allFound[m]);
        for (var n = 0; n < kids.length; n++) {
            try {
                if (kids[n].type === 2 && isNameIgnored(kids[n].name, ignored)) continue;
                moveOrThrow(kids[n], canonical);
                if (ctx) ctx.mergeUndo.push({ id: String(kids[n].nodeId), fromParts: fromParts });
            } catch (e) {}
        }
        if (ctx) ctx.emptied[idKey(allFound[m].nodeId)] = true;
    }

    return canonical;
}

// Le chutier parent d'un chutier (null si introuvable, root si à la racine).
function parentBinOf(root, bin) {
    var found = null;
    function walk(parent) {
        var ch = getChildren(parent);
        for (var i = 0; i < ch.length && !found; i++) {
            if (ch[i].type !== 2) continue;
            if (ch[i].nodeId === bin.nodeId) { found = parent; return; }
            walk(ch[i]);
        }
    }
    walk(root);
    return found;
}

// Segments du chemin du PARENT d'un chutier (là où le remettre).
function parentPathOf(root, bin) {
    var parts = binPathOf(root, bin);
    return parts.slice(0, parts.length - 1);
}

function findBinsDeep(parent, name, results, ignored) {
    var ch = getChildren(parent);
    for (var i = 0; i < ch.length; i++) {
        if (ch[i].type === 2) {
            // Un chutier « Ignorer » n'est jamais réutilisé comme chutier de
            // catégorie, et on ne descend pas dedans : promesse tenue.
            if (isNameIgnored(ch[i].name, ignored)) continue;
            if (sameName(ch[i].name, name)) results.push(ch[i]);
            findBinsDeep(ch[i], name, results, ignored); // sous-bins aussi
        }
    }
}

// Sous-chutier direct `name` de `parent`, créé si `create` (et noté dans
// ctx.created : seuls les chutiers créés par ce rangement partent à l'annulation).
function findChildBin(parent, name, create, ctx) {
    var ch = getChildren(parent);
    for (var i = 0; i < ch.length; i++) {
        if (ch[i].type === 2 && sameName(ch[i].name, name)) return ch[i];
    }
    if (!create) return null;
    try {
        var made = parent.createBin(name);
        if (made && ctx) { ctx.created[idKey(made.nodeId)] = true; ctx.binObj[idKey(made.nodeId)] = made; }
        return made;
    } catch (e) { return null; }
}

// Tous les éléments et tous les chutiers, par nodeId (annulation).
function indexEverything(parent, byId) {
    var ch = getChildren(parent);
    for (var i = 0; i < ch.length; i++) {
        try {
            byId[idKey(ch[i].nodeId)] = ch[i];
            if (ch[i].type === 2) indexEverything(ch[i], byId);
        } catch (e) {}
    }
}

// Segments (ou, pour un ancien instantané, « 02 video/Cuisine ») → le chutier,
// recréé segment par segment si besoin. Vide = la racine.
function resolveBinPath(root, path) {
    var parts;
    if (path && typeof path === "object" && path.length !== undefined) parts = path;
    else {
        var p = trimStr(path || "");
        if (!p.length) return root;
        parts = p.split("/");
    }
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
        var seg = trimStr(parts[i]);
        if (!seg.length) continue;
        var next = findChildBin(cur, seg, true);
        if (!next) throw new Error("cannot create bin " + seg);
        cur = next;
    }
    return cur;
}

// Tous les éléments (hors chutiers) sous `parent`, récursivement, avec leur
// chutier parent et leur chemin. Un chutier listé dans « Ignorer » n'est ni
// parcouru, ni vidé, ni supprimé.
function collectItemsDeep(parent, result, ignoredBins, parts) {
    var ch = getChildren(parent);
    for (var i = 0; i < ch.length; i++) {
        try {
            if (ch[i].type === 2) {
                if (isNameIgnored(ch[i].name, ignoredBins)) continue;
                collectItemsDeep(ch[i], result, ignoredBins, (parts || []).concat([String(ch[i].name)]));
            } else {
                result.push(entryFor(ch[i], parent, parts || []));
            }
        } catch (e) {}
    }
}

// Une seule lecture de `children` : chaque accès reconstruit la collection
// côté hôte, et ce parcours est le plus fréquent du script.
function getChildren(parent) {
    var arr = [];
    try {
        var col = parent.children;
        var n = col.numItems;
        for (var i = 0; i < n; i++) arr.push(col[i]);
    } catch (e) {}
    return arr;
}

// =============================================================================
//  HELPERS — Catégorisation
// =============================================================================

function normalizeList(arr) {
    var out = [];
    if (!arr) return out;
    for (var i = 0; i < arr.length; i++) {
        var s = trimStr(arr[i]).toLowerCase();
        if (s.length > 0) out.push(s);
    }
    return out;
}

// Comparaison de noms de chutiers : insensible à la casse et aux espaces de
// bord, comme isNameIgnored. Sinon « 02 Video » et « 02 video » sont deux
// chutiers distincts et on en recrée un à chaque passage.
function sameName(a, b) {
    return trimStr(a).toLowerCase() === trimStr(b).toLowerCase();
}

function isNameIgnored(name, ignored) {
    if (!ignored || !ignored.length) return false;
    var n = trimStr(name).toLowerCase();
    for (var i = 0; i < ignored.length; i++) {
        if (n === ignored[i]) return true;
    }
    return false;
}

function isMerged(item) {
    try { return item.isMergedClip && item.isMergedClip(); } catch (e) {}
    return false;
}

function isItemOffline(item) {
    try { return item.isOffline && item.isOffline(); } catch (e) {}
    return false;
}

// Motifs b-roll. Deux familles, reconnaissables à la présence d'un « / » :
//   « dji », « gopr »   → cherchés dans le nom de fichier et le nom d'élément
//   « /b-roll/ », « /stock/ » → cherchés dans le CHEMIN complet du média
// Sans cette distinction, « dji » collerait à tout un disque « DJI_SSD ».
function matchesBrollName(fname, itemName, mediaPath, patterns) {
    if (patterns.length === 0) return false;
    var haystack = (fname + " " + itemName).toLowerCase();
    var pathHay  = String(mediaPath || "").toLowerCase();
    for (var i = 0; i < patterns.length; i++) {
        var pat = patterns[i];
        if (pat.indexOf("/") !== -1) {
            if (pathHay && pathHay.indexOf(pat) !== -1) return true;
        } else if (haystack.indexOf(pat) !== -1) {
            return true;
        }
    }
    return false;
}

// Dossiers du chemin d'un média (sans le nom du fichier), en minuscules.
function dirSegments(mediaPath) {
    var parts = String(mediaPath || "").replace(/\\/g, "/").split("/");
    parts.pop();
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i]) out.push(parts[i].toLowerCase());
    }
    return out;
}

// « 03 Exports » → « exports » : les dossiers de l'utilisateur sont numérotés.
function stripNumberPrefix(seg) {
    return String(seg).replace(/^\d+[\s._-]*/, "");
}

// Motifs de chemin purs (exports). Un motif sans « / » doit être un NOM DE
// DOSSIER entier, numéro devant toléré : « render » ne colle pas à
// « surrender_final.mp4 », « exports » colle à « 03 Exports ». Un motif avec
// « / » est cherché tel quel dans le chemin.
function matchesPathPattern(mediaPath, patterns) {
    if (!patterns.length) return false;
    var hay = String(mediaPath).toLowerCase();
    var segs = null;
    for (var i = 0; i < patterns.length; i++) {
        var pat = patterns[i];
        if (pat.indexOf("/") !== -1) {
            if (hay.indexOf(pat) !== -1) return true;
            continue;
        }
        if (!segs) segs = dirSegments(mediaPath);
        for (var s = 0; s < segs.length; s++) {
            if (segs[s] === pat || stripNumberPrefix(segs[s]) === pat) return true;
        }
    }
    return false;
}

// Le dossier le plus proche du fichier qui dise ce qu'il contient :
// « music » (sa bibliothèque « /Volumes/Ssd 2/Musique/… »), « sfx » (« SFX
// Library/Clicks & UI/Tap 4.wav »), « broll » (« New reels/B ROLLS/… »,
// « Assets/B roll/… »). Le plus proche gagne : « Music & SFX/Music/x.mp3 » est
// une musique. Mesuré sur 11 projets : 93 b-rolls, 15 SFX et 34 musiques
// étaient rangés à côté des rushes ou dans Music faute de lire le dossier.
var MUSIC_FOLDER_RE = /^(musique|musiques|music|musics|musik)$/;
var SFX_FOLDER_RE   = /(^|[^a-z])(sfx|sound ?effects?|bruitages?)([^a-z]|$)/;
var BROLL_FOLDER_RE = /(^|[^a-z])b[\s_-]?rolls?([^a-z]|$)/;
function nearestFolderKind(mediaPath) {
    var segs = dirSegments(mediaPath);
    var joined = "/" + segs.join("/") + "/";
    for (var i = segs.length - 1; i >= 0; i--) {
        var seg = segs[i];
        if (MUSIC_FOLDER_RE.test(stripNumberPrefix(seg))) return "music";
        if (SFX_FOLDER_RE.test(seg)) return "sfx";
        if (BROLL_FOLDER_RE.test(seg)) return "broll";
    }
    // Bibliothèques de sons des extensions (Premiere Composer, Animation Composer)
    if (joined.indexOf("/premiere composer files/audio/") !== -1 ||
        joined.indexOf("/animation composer/packs/assets/") !== -1) return "sfx";
    return "";
}

// Voix reconnaissables à coup sûr, avant tout autre mot : ElevenLabs, Adobe
// Podcast « Enhance Speech » (« 8-16-esv2-50p-bg-1p-music-m.wav » — qui
// contient « music » !), pistes micro (« …_M_MIC_1.wav », « MIC3.WAV »,
// « Track1-Mic 1.wav »). Un micro suivi d'un numéro, ou en fin de nom :
// « Mic Drop SFX » n'est pas une voix. Mesuré : 99 voix sur 99 finissaient
// dans Music, le chutier Voice était toujours vide.
var VOICE_SIGNATURE_RE = /elevenlabs|(^|[^a-z0-9])esv2([^a-z0-9]|$)|(^|[^a-z])mic[\s_-]?\d+|(^|[^a-z])mic(\.[a-z0-9]+)?$/;
// Un nom qui se dit musique reste musique, même s'il contient un mot d'effet
// (« …Background Music … Cinematic Impact.m4a »).
var MUSIC_WORD_RE = /(^|[^a-z])(music|musique|instrumental|soundtrack|bgm)([^a-z]|$)/;
var SFX_WORD_RE   = /(^|[^a-z])sfx([^a-z]|$)/;

// Sous-catégorie audio. Les motifs sont courts (« vo », « sfx ») : un simple
// indexOf ferait de « love.mp3 » une voix off. Un motif de moins de 4 lettres
// doit donc être un MOT entier (séparé par _ - espace . etc.) ; à partir de 4
// lettres la sous-chaîne suffit (« whoosh_01 », « rodemic »). Un motif avec
// « / » vise le dossier, comme pour les b-rolls. Ordre : signatures de voix,
// mots de musique, mots d'effets, mots de voix, puis le dossier le plus proche.
function audioSubFor(fname, itemName, mediaPath, ctx) {
    var name = (fname.length > 0 ? fname : String(itemName)).toLowerCase();
    var path = String(mediaPath || "").toLowerCase();
    if (VOICE_SIGNATURE_RE.test(name)) return "voice";
    if (MUSIC_WORD_RE.test(name)) return "music";
    if (matchesWordy(name, ctx.sfxPatterns) || matchesPathWords(path, ctx.sfxPatterns)) return "sfx";
    if (matchesWordy(name, ctx.voicePatterns) || matchesPathWords(path, ctx.voicePatterns)) return "voice";
    var near = nearestFolderKind(mediaPath);
    if (near === "sfx") return "sfx";
    return "music";
}

// Motifs « /dossier » d'une liste de mots : cherchés dans le chemin.
function matchesPathWords(path, patterns) {
    if (!path) return false;
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].indexOf("/") !== -1 && path.indexOf(patterns[i]) !== -1) return true;
    }
    return false;
}

// Disque d'un chemin « /Volumes/<nom>/… » (Mac) ou « E:/… » (Windows) qui
// n'est pas monté, sinon "".
// Folder existe dans ExtendScript ; ailleurs (tests) on le suppose monté.
function unpluggedDrive(mediaPath, cache) {
    var s = String(mediaPath || "");
    var m = /^\/Volumes\/([^\/]+)\//.exec(s), vol, root;
    if (m) {
        vol = m[1];
        root = "/Volumes/" + vol;
    } else {
        // Windows : un disque externe est une lettre (« E:/Rushes/… », chemin
        // déjà passé en « / » par l'appelant). C: ne se débranche pas, mais le
        // test est le même et répond « monté ».
        m = /^([A-Za-z]):\//.exec(s);
        if (m) {
            vol = m[1].toUpperCase() + ":";
            root = vol + "/";
        } else {
            // Partage réseau Windows (« \\nas\rushes\… », déjà en « / ») :
            // un NAS éteint, c'est un disque débranché, pas des fichiers perdus.
            m = /^(\/\/[^\/]+\/[^\/]+)\//.exec(s);
            if (!m) return "";
            vol = m[1];
            root = m[1];
        }
    }
    if (cache[vol] === undefined) {
        var mounted = true;
        try { if (typeof Folder !== "undefined") mounted = !!Folder(root).exists; } catch (e) { mounted = true; }
        cache[vol] = mounted;
    }
    return cache[vol] ? "" : vol;
}

function matchesWordy(name, patterns) {
    if (!patterns.length) return false;
    // Coupé aussi entre lettres et chiffres : « MIC1 » se lit « mic 1 ».
    var tokens = name.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(/[^a-z0-9]+/);
    for (var i = 0; i < patterns.length; i++) {
        var pat = patterns[i];
        if (pat.length >= 4) {
            if (name.indexOf(pat) !== -1) return true;
            continue;
        }
        for (var t = 0; t < tokens.length; t++) {
            if (tokens[t] === pat) return true;
        }
    }
    return false;
}

// Détecte les téléchargements TikTok / Pinterest à leur format de nom :
//   TikTok    : long identifiant numérique   → 7588196048716238101.mp4
//   Pinterest : long hash hexadécimal ±_720w → fccc8a42a3f7b068c9dd7d12b85d7a57_720w.mp4
function looksLikeSocialName(fname, itemName) {
    var name = fname.length > 0 ? fname : String(itemName);

    var dot  = name.lastIndexOf(".");
    var base = dot !== -1 ? name.substring(0, dot) : name;
    base = base.replace(/ \(\d+\)$/, ""); // ignorer les suffixes " (1)" des doublons

    // Nom entièrement numérique : id TikTok, ou id de Pin sans titre.
    //
    // La borne était 18-19 pour éviter qu'un horodatage caméra
    // AAAAMMJJHHMMSSmmm (17 chiffres) parte en b-roll. Sauf que sur 80 fichiers
    // réellement téléchargés, des id de 15, 16 et 17 chiffres existent bel et
    // bien — 10977592837695411.mp4 en est un. La borne écartait donc de vrais
    // b-rolls pour se protéger d'un cas qu'un contrôle de structure traite
    // mieux : on lit la date au lieu de compter les chiffres.
    if (/^\d{15,19}$/.test(base) && !looksLikeCameraTimestamp(base)) return true;

    // Pinterest : hash hexadécimal. On EXIGE au moins une lettre a-f, sinon le
    // motif recouvre les noms purement numériques (horodatages de caméras,
    // compteurs d'export) qui n'ont rien de réseaux sociaux.
    if (/^[0-9a-fA-F]{24,40}(_\d+w)?$/.test(base) && /[a-fA-F]/.test(base)) return true;

    // Pinterest : titre + id de Pin — « deco-salon_771874823639535801.mp4 ».
    // C'est le modèle de nom par défaut de l'extension Pinterest Quick Download.
    // Sans ce motif, un rush déposé par le pont repart dans « vidéo » au
    // prochain rangement et il faut le redescendre à la main.
    //
    // Bornes mesurées sur 45 fichiers réellement téléchargés : les id vont de
    // 15 à 19 chiffres (25 en 18, 11 en 19, 6 en 17, 2 en 16, 1 en 15). Une
    // borne à 18 en ratait donc un sur cinq.
    //
    // Le risque de ce plus large filet est l'horodatage caméra, qui fait
    // exactement 17 chiffres — d'où le contrôle de structure ci-dessous plutôt
    // qu'un simple comptage.
    // Le « _01 » final est le {index} des carrousels et des Idea Pins, qui
    // déposent plusieurs fichiers pour un même Pin. Sans le tolérer, 16 des 80
    // fichiers mesurés passaient à côté.
    var tail = /_(\d{15,19})(?:_\d{1,3})?$/.exec(base);
    if (tail && !looksLikeCameraTimestamp(tail[1])) return true;

    // Les autres façons dont un b-roll arrive, mesurées sur 11 projets réels
    // (258 vidéos sur 825 étaient rangées avec les rushes) :
    // Envato Elements — « young-adult-in-bed-using-phone-2026-09-17-17-02-47-utc »
    if (/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-utc$/i.test(base)) return true;
    // Outils de téléchargement — « PinDown.io_@hope_pin_1774103245 »,
    // « From Klickpin.com- … -pin-id-67131850691878709 », « snaptik_6888… »
    if (/pindown\.io|klickpin|snapinsta|snaptik|ssstik|savefrom|pin-id-\d{9,}/i.test(base)) return true;
    // Pexels et banques du même format — « 7580272-uhd_2160_4096_25fps »,
    // « …Pituitary_Gland_fhd_4227461 »
    if (/^\d{5,9}-(uhd|hd|sd)_\d+_\d+_\d+fps$/i.test(base) || /_(uhd|fhd|hd|4k)_\d{6,9}$/i.test(base)) return true;
    // TikTok enregistré avec le compte, ou une qualité collée à l'id —
    // « tuftandpaw - 7272539256923475205 », « 7398521278027615521sd »
    var tk = /(?:^|\s-\s)(\d{15,19})(?:sd|hd)?$/i.exec(base);
    if (tk && !looksLikeCameraTimestamp(tk[1])) return true;

    return false;
}

/**
 * AAAAMMJJHHMMSSmmm — 17 chiffres, la seule longueur qui entre en collision
 * avec un id de Pin. On ne compte pas les chiffres, on lit la date : un id
 * comme 20969954511893939 commence lui aussi par « 20 », mais annonce le mois
 * 96, ce qu'aucune caméra n'écrira jamais.
 */
function looksLikeCameraTimestamp(digits) {
    if (digits.length !== 17 && digits.length !== 14) return false;
    var year  = parseInt(digits.substring(0, 4), 10);
    var month = parseInt(digits.substring(4, 6), 10);
    var day   = parseInt(digits.substring(6, 8), 10);
    var hour  = parseInt(digits.substring(8, 10), 10);
    var min   = parseInt(digits.substring(10, 12), 10);
    var sec   = parseInt(digits.substring(12, 14), 10);
    return year >= 1990 && year <= 2100 &&
           month >= 1 && month <= 12 &&
           day >= 1 && day <= 31 &&
           hour <= 23 && min <= 59 && sec <= 59;
}

function getExtFrom(fname, itemName) {
    if (fname.length > 0) {
        var dot = fname.lastIndexOf(".");
        if (dot !== -1) return fname.substring(dot + 1).toLowerCase();
    }
    // Repli sur le nom de l'élément, mais seulement si le suffixe est une
    // extension qu'on sait réellement classer. Sinon « Interview.prise2 »
    // donnerait l'extension « prise2 ».
    //
    // Surtout PAS de contrainte de longueur : « prfpset » fait 7 caractères
    // et « aegraphic » 9, et les filtrer vidait le chutier Styles.
    var parts = String(itemName).split(".");
    if (parts.length > 1) {
        var last = parts[parts.length - 1].toLowerCase();
        if (isVideo(last) || isAudio(last) || isImage(last) ||
            isAnim(last)  || isStyle(last)) return last;
    }
    return "";
}

function trimStr(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
}

function isVideo(e) {
    return e==="mp4"||e==="mov"||e==="mxf"||e==="mkv"||e==="avi"||
           e==="r3d"||e==="braw"||e==="mts"||e==="m2ts"||e==="webm"||e==="wmv"||
           // Canon RAW Light (C70/C300), captures broadcast, 360, formats hérités
           e==="crm"||e==="ts"||e==="m4v"||e==="mpg"||e==="mpeg"||
           e==="insv"||e==="3gp"||e==="dv"||e==="ari";
}
function isAudio(e) {
    return e==="mp3"||e==="wav"||e==="m4a"||e==="aiff"||e==="aif"||
           e==="flac"||e==="ogg"||e==="aac"||e==="wma"||e==="opus"||e==="caf";
}
function isImage(e) {
    return e==="jpg"||e==="jpeg"||e==="png"||e==="psd"||e==="webp"||
           e==="tiff"||e==="tif"||e==="heic"||e==="bmp"||e==="gif"||
           e==="ai"||e==="svg"||
           // RAW photo (drones, boîtiers) et plaques VFX
           e==="dng"||e==="cr2"||e==="cr3"||e==="nef"||e==="arw"||e==="raf"||
           e==="exr"||e==="dpx"||e==="tga";
}
function isStyle(e) {
    return e==="prfpset"||e==="preset"||e==="cube"||e==="look"||
           e==="3dl"||e==="csp"||e==="prtl";
}
// Animations & templates : MOGRT + graphiques After Effects (.aep/.aegraphic)
function isAnim(e)  { return e==="mogrt"||e==="mgt"||e==="aep"||e==="aegraphic"; }

// =============================================================================
//  HELPERS — Séquences imbriquées
//
//  Tout ici répond à une seule question : cette séquence est-elle utilisée
//  DANS une autre timeline ? La seule API publique qui sache y répondre est le
//  parcours des pistes de chaque séquence — donc ce parcours doit être juste,
//  et, quand il revient bredouille, il doit le DIRE au lieu de conclure en
//  silence que rien n'est imbriqué. C'est ce silence qui rangeait les six
//  séquences et leurs imbriquées dans le même chutier.
// =============================================================================

// Le préfixe « n: » évite de heurter les membres hérités d'Object : sans lui,
// info.byName["constructor"] (ou "toString", "valueOf"…) est toujours vrai et
// une séquence portant ce nom serait classée imbriquée d'office.
function nameKey(name) {
    return "n:" + trimStr(name).toLowerCase();
}

// Même précaution pour les nodeId, qui arrivent en chaîne depuis l'hôte.
function idKey(id) {
    return "i:" + String(id);
}

// Le nom que Premiere donne à une imbrication, en anglais et en français.
// Échappements \u plutôt que « é » littéral : l'encodage dans lequel
// ExtendScript lit ce fichier n'est pas garanti, un accent mal décodé ferait
// échouer la règle sans bruit.
// Noms que Premiere donne à une imbrication dans ses langues (relevés dans
// ses dictionnaires, 2026) : anglais, français, allemand, espagnol, italien,
// portugais, japonais, coréen, russe, chinois. Fabriqués par code : la source
// reste en ASCII, quel que soit l'encodage dans lequel ExtendScript la lit.
var NEST_NAMES = (function () {
    function t(codes) { var o = ""; for (var i = 0; i < codes.length; i++) o += String.fromCharCode(codes[i]); return o; }
    return [
        "nested sequence",
        "s" + t([0xe9]) + "quence imbriqu" + t([0xe9]) + "e",
        "sequence imbriquee",
        "verschachtelte sequenz",
        "secuencia anidada",
        "sequenza nidificata",
        "sequ" + t([0xea]) + "ncia aninhada",
        "sequencia aninhada",
        t([0x30cd, 0x30b9, 0x30c8, 0x3055, 0x308c, 0x305f, 0x30b7, 0x30fc, 0x30b1, 0x30f3, 0x30b9]),
        t([0xc911, 0xcca9]) + " " + t([0xc2dc, 0xd000, 0xc2a4]),
        t([0x0432, 0x043b, 0x043e, 0x0436, 0x0435, 0x043d, 0x043d, 0x0430, 0x044f]) + " " +
            t([0x043f, 0x043e, 0x0441, 0x043b, 0x0435, 0x0434, 0x043e, 0x0432, 0x0430, 0x0442, 0x0435, 0x043b, 0x044c, 0x043d, 0x043e, 0x0441, 0x0442, 0x044c]),
        t([0x0412, 0x043b, 0x043e, 0x0436, 0x0435, 0x043d, 0x043d, 0x0430, 0x044f]) + " " +
            t([0x043f, 0x043e, 0x0441, 0x043b, 0x0435, 0x0434, 0x043e, 0x0432, 0x0430, 0x0442, 0x0435, 0x043b, 0x044c, 0x043d, 0x043e, 0x0441, 0x0442, 0x044c]),
        t([0x5d4c, 0x5957, 0x5e8f, 0x5217])
    ];
})();

function looksNestedByName(name) {
    var raw = String(name).replace(/^\s+/, "");
    var low = raw.toLowerCase();
    for (var i = 0; i < NEST_NAMES.length; i++) {
        var p = NEST_NAMES[i];
        var hit = (low.substring(0, p.length) === p) ? low : ((raw.substring(0, p.length) === p) ? raw : null);
        if (hit === null) continue;
        // « Nested Sequence 12 », pas « Nested Sequences ».
        if (!/[a-z0-9]/.test(hit.charAt(p.length))) return true;
    }
    return false;
}

// Règles de séquences écrites par l'utilisateur dans le panneau (« Hook »,
// « 4 ADS »…). Demandé le 30/09 : dans « Project D », 36 séquences « Hook 1 »
// … « Body 5 » finissaient dans 08 parce que « 4 ADS CLIENT A » les utilise — pour
// lui ce sont des montages. Une règle est une suite de MOTS ENTIERS, sans
// casse : « Hook » prend « Hook 1 » et « hook 7 », pas « Hookah » ; « 4 ADS »
// prend « 4 ADS CLIENT A ». Lettres et chiffres collés sont séparés, comme pour les
// médias : « Hook1 » se lit « hook 1 ».
// Sans accents ni casse : « temoignage » trouve « Témoignage 2 », y compris
// quand l'accent est un caractère combinant (noms venus d'un Mac). Mots séparés
// par les espaces et la ponctuation seulement : un nom en cyrillique ou en
// japonais garde ses mots. Fabriqué par code, comme NEST_NAMES.
var FOLD = (function () {
    function cls(codes) { var o = ""; for (var i = 0; i < codes.length; i++) o += String.fromCharCode(codes[i]); return new RegExp("[" + o + "]", "g"); }
    return [
        [cls([0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5]), "a"], [cls([0xe7]), "c"],
        [cls([0xe8, 0xe9, 0xea, 0xeb]), "e"], [cls([0xec, 0xed, 0xee, 0xef]), "i"],
        [cls([0xf1]), "n"], [cls([0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf8]), "o"],
        [cls([0xf9, 0xfa, 0xfb, 0xfc]), "u"], [cls([0xfd, 0xff]), "y"],
        [cls([0x153]), "oe"], [cls([0xe6]), "ae"], [cls([0xdf]), "ss"]
    ];
})();
var COMBINING = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
var WORD_SPLIT = new RegExp("[\\s_\\-.,;:!?()\\[\\]{}'\"/\\\\|#@&+*=<>~`^%$" +
    String.fromCharCode(0xab, 0xbb, 0x2013, 0x2014, 0x2026, 0xb7, 0x2018, 0x2019, 0x201c, 0x201d, 0xa0) + "]+");

function foldName(s) {
    var o = String(s).toLowerCase().replace(COMBINING, "");
    for (var i = 0; i < FOLD.length; i++) o = o.replace(FOLD[i][0], FOLD[i][1]);
    return o;
}

function nameTokens(s) {
    var parts = foldName(s)
        .replace(/([a-z])(\d)/g, "$1 $2")
        .replace(/(\d)([a-z])/g, "$1 $2")
        .split(WORD_SPLIT);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].length) out.push(parts[i]);
    }
    return out;
}

function wordRules(list) {
    var out = [], norm = normalizeList(list);
    for (var i = 0; i < norm.length; i++) {
        var t = nameTokens(norm[i]);
        if (t.length) out.push(t);
    }
    return out;
}

function hasWords(tokens, rules) {
    for (var r = 0; r < rules.length; r++) {
        var w = rules[r];
        for (var i = 0; i + w.length <= tokens.length; i++) {
            var j = 0;
            while (j < w.length && tokens[i + j] === w[j]) j++;
            if (j === w.length) return true;
        }
    }
    return false;
}

// "nested" | "seq" | "" (aucune règle ne parle de ce nom). Si les deux listes
// prennent le même nom, « Always nested » l'emporte. Vient APRÈS les noms que
// Premiere et AutoCut donnent eux-mêmes : « Sequence » dans « Always edits »
// ne doit pas sortir « Nested Sequence 12 » de 08.
function ruleVerdict(ctx, name) {
    var rules = ctx.seqRules;
    if (!rules || (!rules.nested.length && !rules.seq.length)) return "";
    var tokens = nameTokens(name);
    if (hasWords(tokens, rules.nested)) return "nested";
    if (hasWords(tokens, rules.seq)) return "seq";
    return "";
}

// isSequence() est la seule réponse qui fasse autorité — surtout pas le type,
// cf. le commentaire dans buildPlan(). Les chutiers ne sont jamais collectés,
// il n'y a donc rien d'autre à écarter que les clips fusionnés.
function isSequenceItem(item) {
    try {
        return !!(item && item.isSequence && item.isSequence() && !isMerged(item));
    } catch (e) {}
    return false;
}

function getNestedInfo(opts) {
    opts = opts || {};
    var info = {
        byId: {}, byName: {}, nameCount: {},
        mode:        opts.activeOnly ? "active" : "full",
        seqCount:    0,   // séquences dans le projet
        tracksSeen:  0,   // pistes réellement parcourues
        clipsSeen:   0,   // clips réellement parcourus
        nestedFound: 0,   // clips qui se sont révélés être une séquence
        opened:      0,   // séquences qu'il a fallu ouvrir pour lire leurs pistes
        errors:      [],
        // Nature de chaque élément du projet vu dans une piste, par nodeId :
        // un rush découpé en 500 morceaux n'est interrogé qu'UNE fois.
        kind:        {},
        nameOf:      {}
    };

    try {
        info.seqCount = app.project.sequences.numSequences;
    } catch (e) {
        info.errors.push("sequences: " + e);
        return info;
    }

    // Combien de séquences portent chaque nom ? Le repli par nom ne vaut que si
    // le nom est unique : « Séquence 01 » revient constamment, et une séquence
    // normale ne doit pas hériter du classement d'une autre.
    for (var c = 0; c < info.seqCount; c++) {
        try {
            var k = nameKey(app.project.sequences[c].name);
            info.nameCount[k] = (info.nameCount[k] || 0) + 1;
        } catch (eName) {
            info.errors.push("nom[" + c + "]: " + eName);
        }
    }

    // Timeline active seulement (passage automatique) : une séquence neuve
    // qu'on vient d'utiliser l'est dans la timeline où l'on travaille.
    if (opts.activeOnly) {
        try {
            var active = app.project.activeSequence;
            if (active) scanSequenceTracks(active, info);
        } catch (eAct) {
            info.errors.push("active: " + eAct);
        }
        // Jamais d'ouverture de séquences ici : ce passage tourne pendant que
        // l'utilisateur monte, lui changer de timeline serait inacceptable.
        return info;
    }

    for (var i = 0; i < info.seqCount; i++) {
        try {
            scanSequenceTracks(app.project.sequences[i], info);
        } catch (eScan) {
            info.errors.push("scan[" + i + "]: " + eScan);
        }
    }

    // Pas UN seul clip dans tout le projet alors qu'il y a des séquences : les
    // pistes n'étaient pas lisibles, pas vides. Selon les versions, Premiere
    // renvoie une Sequence dont la collection de pistes reste vide tant que
    // cette séquence n'a pas été ouverte au moins une fois dans la session —
    // et une séquence que personne n'a ouverte, c'est exactement le cas ici.
    // Les ouvrir est le seul moyen de les lire ; on remet ensuite la timeline
    // là où l'utilisateur l'avait laissée. (Premiere 26.5 lit les pistes sans
    // cela — mesuré sur les projets réels — mais les versions plus anciennes
    // ne sont pas garanties.)
    // Pistes illisibles = aucune piste lue du tout. Des séquences vides (un
    // projet neuf) se lisent très bien : les ouvrir toutes ferait apparaître un
    // onglet par séquence dans Premiere.
    if (info.tracksSeen === 0 && info.seqCount > 0) {
        var previous = null;
        try { previous = app.project.activeSequence; } catch (eActive) {}

        for (var o = 0; o < info.seqCount; o++) {
            try {
                var seq = app.project.sequences[o];
                app.project.openSequence(seq.sequenceID);
                info.opened++;
                // Relire par la séquence fraîchement ouverte : l'objet qu'on
                // tenait avant peut encore porter la collection de pistes vide.
                scanSequenceTracks(app.project.activeSequence || seq, info);
            } catch (eOpen) {
                info.errors.push("ouverture[" + o + "]: " + eOpen);
            }
        }

        try {
            if (previous) app.project.openSequence(previous.sequenceID);
        } catch (eBack) {
            info.errors.push("retour: " + eBack);
        }
    }

    return info;
}

function scanSequenceTracks(seq, info) {
    if (!seq) return;
    try {
        collectNestedFromTracks(seq.videoTracks, info);
    } catch (eV) {
        info.errors.push("videoTracks: " + eV);
    }
    try {
        collectNestedFromTracks(seq.audioTracks, info);
    } catch (eA) {
        info.errors.push("audioTracks: " + eA);
    }
}

// Vrai seulement si on est sûr : soit le nodeId correspond, soit le nom
// correspond ET il est unique dans le projet.
function isNestedSeq(item, nested) {
    if (nested.byId[idKey(item.nodeId)]) return true;
    var k = nameKey(item.name);
    return !!nested.byName[k] && nested.nameCount[k] === 1;
}

// Le chemin le plus chaud du script : chaque clip de chaque piste de chaque
// séquence. Trois appels à l'hôte par clip — le clip, son élément de projet,
// le nodeId de cet élément — et la nature de l'élément n'est demandée qu'une
// fois par élément distinct (cache info.kind). La collection `clips` d'une
// piste est lue une fois, pas une fois par clip : chaque lecture reconstruit
// la collection côté hôte.
function collectNestedFromTracks(tracks, info) {
    var numTracks = 0;
    try {
        numTracks = tracks.numTracks;
    } catch (eN) {
        info.errors.push("numTracks: " + eN);
        return;
    }

    for (var t = 0; t < numTracks; t++) {
        try {
            var track = tracks[t];
            info.tracksSeen++;
            var clips = track.clips;
            var numClips = clips.numItems;

            for (var c = 0; c < numClips; c++) {
                info.clipsSeen++;
                try {
                    var pi = clips[c].projectItem;
                    if (!pi) continue;                 // titre, graphique, calque d'effets
                    var k = idKey(pi.nodeId);
                    var known = info.kind[k];
                    if (known === undefined) {
                        // Un clip fusionné répond lui aussi true à isSequence().
                        // L'enregistrer entraînerait dans le chutier des
                        // imbriquées une vraie séquence qui porterait son nom.
                        known = isSequenceItem(pi) ? 1 : 0;
                        // Nom lu AVANT de mémoriser : s'il lève, on réessaiera
                        // au clip suivant plutôt que d'enregistrer « undefined ».
                        var nm = known ? String(pi.name) : "";
                        info.kind[k] = known;
                        if (known) info.nameOf[k] = nm;
                    }
                    if (known) {
                        info.nestedFound++;
                        info.byId[k] = true;
                        info.byName[nameKey(info.nameOf[k])] = true;
                    }
                } catch (eClip) {}
            }
        } catch (eTrack) {
            info.errors.push("piste[" + t + "]: " + eTrack);
        }
    }
}

// =============================================================================
//  EXPORTS — la seule chose visible depuis l'extérieur.
//  tests/check-panel.mjs vérifie que chaque fonction appelée par le panneau
//  figure ici. `_test` expose des internes aux suites de tests, rien d'autre
//  ne doit s'en servir.
// =============================================================================

return {
    version:             VERSION,
    resetAndOrganize:    resetAndOrganize,
    previewOrganize:     previewOrganize,
    undoOrganize:        undoOrganize,
    backToNormal:        backToNormal,
    getProjectSignature: getProjectSignature,
    diagnoseNested:      diagnoseNested,
    importWatched:       importWatched,
    _test: {
        hasNameWords:        function (name, list) { return hasWords(nameTokens(name), wordRules(list)); },
        getNestedInfo:       getNestedInfo,
        isNestedSeq:         isNestedSeq,
        isSequenceItem:      isSequenceItem,
        looksLikeSocialName: looksLikeSocialName,
        matchesBrollName:    matchesBrollName,
        matchesPathPattern:  matchesPathPattern,
        audioSubFor:         audioSubFor,
        nearestFolderKind:   nearestFolderKind,
        unpluggedDrive:      unpluggedDrive,
        getExtFrom:          getExtFrom
    }
};

})();
