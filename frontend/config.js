(function () {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    window.SF_CATALYST_API_BASE = isLocal
        ? 'http://localhost:3001/'
        : 'https://assets-icons-management-60067235816.development.catalystserverless.in/server/spriteForgeJoin/';
    window.SF_AUTH_ENABLED     = true;
    window.SF_AUTH_STORAGE_KEY = 'sf_session_id';

    // ── Repository (CRM_UI_LIBRARY on ZohoRepository) ─────────────────────────
    // Display defaults for the Master UI Library folder. The server is the source
    // of truth (functions/spriteForgeJoin/.env → REPO_*); these values are used
    // until GET /api/master-library/config answers, and must match that file.
    // The personal token lives ONLY in the server .env (REPO_TOKEN).
    var repoBase    = 'https://repository.zohocorpcloud.in';
    var repoProject = 'zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY';
    var repoBranch  = 'CRM_UI_LIBRARY_ICON_TOOL';
    var repoName    = 'CRM_UI_LIBRARY';
    // Paths are relative to the repo root; the web UI inserts the repo name after the branch.
    var blobUrl = function (p) { return repoBase + '/' + repoProject + '#/blob/' + repoBranch + '/' + repoName + '/' + p; };
    var repoFile = function (p, kind) {
        var name = p.split('/').pop();
        return { name: name, repoPath: p, ext: name.split('.').pop(), kind: kind, webUrl: blobUrl(p) };
    };
    window.SF_REPO_CONFIG = {
        baseUrl:     repoBase,
        projectPath: repoProject,
        repoName:    repoName,
        branch:      repoBranch,
        folder:      'Master_ui_library',
        webUrl:      repoBase + '/' + repoProject + '#/tree/' + repoBranch,
        files: [
            repoFile('resources/images/crmutil_icons.svg',   'sprite'),
            repoFile('resources/images/svg_cssicons.svg',    'sprite'),
            repoFile('resources/icon-styles/svg-icons.less', 'styles'),
            repoFile('resources/icon-styles/svg-path.less',  'styles')
        ],
        // Which stylesheet is edited together with which sprite
        pairs: [
            { svg: 'crmutil_icons.svg', styles: 'svg-icons.less' },
            { svg: 'svg_cssicons.svg',  styles: 'svg-path.less' }
        ]
    };
}());
