// =============================================================================
//  PINTEREST B-ROLL — côté hôte (ExtendScript)
//
//  ⚠️ TOUT vit dans UN SEUL global, PQDBroll.
//
//  Premiere n'a qu'UN moteur ExtendScript, partagé par tous les panneaux. Les
//  deux fichiers .jsx y sont chargés par $.evalFile, et le dernier chargé
//  gagne. La version précédente définissait findBinsDeep() au premier niveau —
//  exactement le nom qu'utilise Isma Organizer, mais avec un argument de moins.
//  Quand la nôtre gagnait, findOrMergeBin() de l'Organizer perdait sa liste
//  « Ignorer » : il sortait des chutiers protégés vers la racine et y fusionnait
//  leur contenu. Un clic dans ce panneau pouvait donc réorganiser un projet à
//  l'insu de l'utilisateur.
//
//  Un seul nom global, choisi pour être unique. Rien d'autre ne fuit.
//
//  API appelée par le panneau :
//    PQDBroll.projectMedia()            -> { ok, name, paths, errors }
//
//  Depuis 2.6.0 l'onglet B-roll ne fait que glisser-déposer : Premiere importe
//  lui-même ce qu'on lâche sur la timeline ou dans un chutier. Les anciennes
//  fonctions d'import et de pose sur la timeline (importBroll, dropOnTimeline)
//  sont retirées : plus rien ne les appelait, et elles ignoraient la liste
//  « Ignorer » de l'onglet Organize.
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

var PQDBroll = (function () {


    // -------------------------------------------------------------------------
    //  Parcours du projet
    // -------------------------------------------------------------------------

    /**
     * Tous les items du projet, en une passe.
     *
     * Renvoie { items, errors }. Une erreur de lecture sur un chutier est
     * COMPTÉE, jamais avalée : la version précédente renvoyait un arbre partiel
     * en silence, et les items manquants n'étaient alors pas reconnus comme
     * déjà présents — ce qui déplaçait les rushes existants de l'utilisateur
     * dans le chutier b-roll et les recolorait.
     */
    function scanProject(root) {
        var out = { items: [], errors: 0 };

        function walk(parent) {
            // Une seule lecture de `children` par chutier : chaque lecture
            // reconstruit la collection côté Premiere (deux par tour de boucle
            // coûtaient ~1 s de Premiere figé sur un gros projet).
            var children = [];
            try {
                var col = parent.children, n = col.numItems;
                for (var i = 0; i < n; i++) children.push(col[i]);
            } catch (e) {
                out.errors++;
                return;
            }
            for (var c = 0; c < children.length; c++) {
                try {
                    if (children[c].type === 2) walk(children[c]);
                    else out.items.push(children[c]);
                } catch (e2) {
                    out.errors++;
                }
            }
        }

        walk(root);
        return out;
    }

    /** Clé de comparaison de chemins. ExtendScript n'a pas normalize(). */
    function pathKey(p) {
        return String(p).replace(/\\/g, '/').replace(/^\s+|\s+$/g, '').toLowerCase();
    }

    function mediaPathOf(item) {
        try {
            var mp = item.getMediaPath();
            return (mp && mp.length) ? String(mp) : '';
        } catch (e) {
            return '';
        }
    }

    // -------------------------------------------------------------------------
    //  API — état du projet
    // -------------------------------------------------------------------------

    function projectMedia() {
        var out = { ok: false, name: '', paths: [], errors: 0 };
        try {
            if (!app.project || !app.project.rootItem) return JSON.stringify(out);
            try { out.name = String(app.project.name); } catch (e) {}

            var scan = scanProject(app.project.rootItem);
            out.errors = scan.errors;
            for (var i = 0; i < scan.items.length; i++) {
                var mp = mediaPathOf(scan.items[i]);
                if (mp) out.paths.push(pathKey(mp));
            }
            // ok=true seulement si le parcours est allé au bout : le panneau ne
            // doit pas prendre une liste tronquée pour la vérité.
            out.ok = (scan.errors === 0);
        } catch (e) {
            out.errors++;
        }
        return JSON.stringify(out);
    }

    return {
        projectMedia: projectMedia
    };
})();
