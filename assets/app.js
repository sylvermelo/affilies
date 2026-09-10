/* ============================================================================
   ESPACE AFFILIÉ — PRONOS FOOT
   Se connecte à Supabase (mêmes URL/clé publique que la vitrine).
   Lit uniquement : mes_stats_affilie() (RPC sécurisé, données masquées côté
   base). Aucune donnée sensible côté navigateur. L'opérateur voit les
   demandes en attente et le journal des gains via les RPC dédiées.
   ========================================================================== */
(function () {
  const CFG = window.AFFILIES_CONFIG || {};
  if (!window.supabase || !CFG.SUPABASE_URL) {
    document.body.innerHTML = "<p style='padding:40px;text-align:center'>Configuration manquante.</p>";
    return;
  }
  const SB = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fcfa = (n) => (Number(n) || 0).toLocaleString("fr-FR");
  const dateFr = (d) => {
    if (!d) return "—";
    try { return new Date(String(d).slice(0, 10) + "T12:00:00Z")
      .toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return String(d); }
  };

  let ETAT = { stats: null };

  /* ------------------------------------------------------- paramètres dynamiques
     Prix, promotion et barème ne sont JAMAIS codés en dur : ils viennent de la
     table Supabase `parametres` (lecture publique). Si la table n'existe pas
     encore (parametres.sql non collé), on retombe sur les valeurs par défaut
     du barème validé le 10/09 — rien ne casse. */
  const PARAM_DEFAUT = {
    prix: { mensuel_fcfa: 2500, duree_jours: 30, devise: "FCFA" },
    promo: { actif: false, prix_fcfa: null, jusquau: null },
    affiliation: { reduction_fcfa: 500, commission_premiere: 1000, commission_renouvellement: 500, seuil_paiement_fcfa: 2500 },
  };
  let PARAM = JSON.parse(JSON.stringify(PARAM_DEFAUT));
  const aujourdhuiISO = () => new Date().toISOString().slice(0, 10);
  async function chargeParametres() {
    try {
      const r = await SB.from("parametres").select("cle,valeur");
      if (!r.error && r.data) for (const row of r.data) {
        if (PARAM[row.cle]) Object.assign(PARAM[row.cle], row.valeur || {});
      }
    } catch (e) { /* silencieux : valeurs par défaut */ }
    PARAM.promoActive = !!(PARAM.promo.actif && PARAM.promo.prix_fcfa && PARAM.promo.jusquau &&
      String(PARAM.promo.jusquau).slice(0, 10) >= aujourdhuiISO());
    return PARAM;
  }
  /* Prix à afficher/partager : promo si active (avec ancien prix + date), sinon prix normal. */
  function prixAffiche() {
    return PARAM.promoActive
      ? { prix: PARAM.promo.prix_fcfa, barre: PARAM.prix.mensuel_fcfa, jusquau: PARAM.promo.jusquau }
      : { prix: PARAM.prix.mensuel_fcfa, barre: null, jusquau: null };
  }
  function majTextesPalier() {
    const seuil = fcfa(PARAM.affiliation.seuil_paiement_fcfa || 2500);
    const h1 = $("h-palier");
    if (h1) h1.textContent = "Identités masquées — vous voyez uniquement les statuts. " +
      "Paiement des gains : à partir de " + seuil + " F cumulés, vérifié chaque semaine.";
    const h2 = $("h-palier-admin");
    if (h2) h2.textContent = "Gains dus ≥ " + seuil + " F → payez par MoMo puis « Marquer payé ».";
  }
  function seuilPaiement() { return Number(PARAM.affiliation.seuil_paiement_fcfa) || 2500; }

  function montrer(vue) {
    ["auth", "attente", "dash", "admin", "erreur"].forEach((v) => {
      const el = $("view-" + v);
      if (el) el.style.display = v === vue ? (v === "dash" || v === "admin" ? "flex" : "block") : "none";
    });
    if (vue === "dash" || vue === "admin") {
      const el = $("view-" + vue);
      if (el) { el.style.flexDirection = "column"; el.style.gap = "16px"; }
    }
  }

  function msg(id, texte, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = texte || "";
    el.className = "msg" + (type ? " " + type : "");
  }

  /* ------------------------------------------------------------------ auth */
  $("tab-connexion").onclick = () => {
    $("tab-connexion").classList.add("on"); $("tab-inscription").classList.remove("on");
    $("pane-connexion").style.display = "block"; $("pane-inscription").style.display = "none";
  };
  $("tab-inscription").onclick = () => {
    $("tab-inscription").classList.add("on"); $("tab-connexion").classList.remove("on");
    $("pane-inscription").style.display = "block"; $("pane-connexion").style.display = "none";
    modeFinalisation(false);
  };

  let EN_FINALISATION = false;
  function modeFinalisation(actif, email) {
    EN_FINALISATION = !!actif;
    const em = $("i-email");
    if (actif) {
      em.value = email || ""; em.disabled = true;
      $("i-btn").textContent = "Finaliser mon compte affilié";
    } else {
      em.disabled = false;
      $("i-btn").textContent = "Créer mon compte affilié";
    }
  }

  $("i-btn").onclick = async () => {
    const prenom = $("i-prenom").value.trim();
    const nom = $("i-nom").value.trim();
    const tel = $("i-tel").value.trim();
    const email = $("i-email").value.trim();
    const mdp = $("i-mdp").value;
    if (!prenom || !email || !mdp) { msg("i-msg", "Prénom, e-mail et mot de passe sont obligatoires.", "erreur"); return; }
    if (mdp.length < 6) { msg("i-msg", "Mot de passe : 6 caractères minimum.", "erreur"); return; }
    $("i-btn").disabled = true;
    msg("i-msg", "…");
    try {
      if (!EN_FINALISATION) {
        const r = await SB.auth.signUp({ email, password: mdp, options: { data: { prenom, nom, telephone: tel } } });
        if (r.error) {
          if (/already|registered|existe/i.test(r.error.message || "")) {
            msg("i-msg", "Cet e-mail a déjà un compte — connectez-vous avec, puis finalisez ici.", "erreur");
            $("c-email").value = email;
            $("tab-connexion").click();
            return;
          }
          throw r.error;
        }
        if (!r.data.session) {
          msg("i-msg", "Compte créé mais une confirmation e-mail est active côté serveur — " +
            "réglage Supabase : Authentication → Providers → Email → désactiver « Confirm email ».", "erreur");
          return;
        }
      }
      const cr = await SB.rpc("creer_compte_affilie", { p_prenom: prenom, p_nom: nom, p_telephone: tel });
      if (cr.error) throw cr.error;
      const d = cr.data || {};
      if (!d.ok) {
        msg("i-msg", d.erreur === "deja_cree" ? "Ce compte a déjà un espace affilié."
          : d.erreur === "email_pris" ? "Cet e-mail est déjà utilisé par un autre affilié."
          : d.erreur === "interdit" ? "Réservé."
          : "Création impossible pour l'instant.", "erreur");
        return;
      }
      await demarrer();
    } catch (e) {
      msg("i-msg", erreurTexte(e), "erreur");
    } finally {
      $("i-btn").disabled = false;
    }
  };

  $("c-btn").onclick = async () => {
    const email = $("c-email").value.trim();
    const mdp = $("c-mdp").value;
    if (!email || !mdp) { msg("c-msg", "E-mail et mot de passe requis.", "erreur"); return; }
    $("c-btn").disabled = true;
    msg("c-msg", "…");
    try {
      const r = await SB.auth.signInWithPassword({ email, password: mdp });
      if (r.error) throw r.error;
      await demarrer();
    } catch (e) {
      msg("c-msg", /Invalid login/i.test(e.message || "") ? "E-mail ou mot de passe incorrect." : erreurTexte(e), "erreur");
    } finally {
      $("c-btn").disabled = false;
    }
  };

  $("c-oubli").onclick = async () => {
    const email = $("c-email").value.trim();
    if (!email) { msg("c-msg", "Saisissez d'abord votre e-mail, puis recliquez ici.", "erreur"); return; }
    const r = await SB.auth.resetPasswordForEmail(email, { redirectTo: location.href });
    msg("c-msg", r.error
      ? "Envoi impossible pour l'instant (le plan gratuit limite les e-mails). Écrivez au propriétaire sur WhatsApp, il réinitialise en 30 secondes."
      : "E-mail de réinitialisation envoyé (vérifiez aussi les spams). S'il n'arrive pas : WhatsApp du propriétaire.",
      r.error ? "erreur" : "ok");
  };

  function erreurTexte(e) {
    const t = (e && (e.message || String(e))) || "";
    if (/function public\.(mes_stats_affilie|creer_compte_affilie|liste_affilies)/i.test(t) || /42883/.test(t))
      return "SQL_MISSING";
    return "Erreur : " + t.slice(0, 160);
  }

  /* -------------------------------------------------------------- démarrage */
  async function demarrer() {
    const { data } = await SB.auth.getSession();
    const sess = data && data.session;
    if (!sess) { montrer("auth"); return; }
    const email = (sess.user && sess.user.email) || "";
    await chargeParametres();
    majTextesPalier();
    if (email.toLowerCase() === (CFG.OPERATEUR_EMAIL || "").toLowerCase()) {
      montrer("admin");
      await chargerAdmin();
      return;
    }
    const r = await SB.rpc("mes_stats_affilie");
    if (r.error) {
      if (erreurTexte(r.error) === "SQL_MISSING") { montrer("erreur"); return; }
      montrer("auth"); msg("c-msg", erreurTexte(r.error), "erreur");
      return;
    }
    const st = r.data || {};
    if (!st.ok) {
      if (st.erreur === "pas_affilie") {
        montrer("auth");
        $("tab-inscription").click();
        modeFinalisation(true, email);
        msg("i-msg", "Vous êtes connecté avec " + email + " — complétez pour créer votre espace affilié.", "ok");
      } else {
        montrer("auth");
      }
      return;
    }
    ETAT.stats = st;
    if (st.statut === "actif") { montrer("dash"); rendreDash(st); }
    else {
      montrer("attente");
      $("a-code").textContent = st.code || "PF-•••••";
      $("a-texte").textContent = st.statut === "suspendu"
        ? "Votre compte est suspendu. Contactez le propriétaire sur WhatsApp pour en savoir plus."
        : "Le propriétaire doit approuver votre compte. Rien à faire : reconnectez-vous plus tard, cette page se mettra à jour.";
    }
  }

  /* ------------------------------------------------------------- tableau de bord */
  function rendreDash(st) {
    $("d-bonjour").textContent = "Bonjour " + (st.prenom || "👋");
    $("d-code").textContent = st.code;
    $("d-lien").textContent = st.lien;
    $("d-tel").value = st.telephone_momo || "";

    const filleuls = st.filleuls || [];
    const actifs = filleuls.filter((f) => f.actif).length;
    $("s-inscrits").textContent = filleuls.length;
    $("s-actifs").textContent = actifs;
    $("s-inactifs").textContent = filleuls.length - actifs;
    $("s-dus").textContent = fcfa(st.gains_dus);
    $("s-payes").textContent = fcfa(st.gains_payes);
    $("s-detail").textContent = (st.nb_premieres || 0) + " / " + (st.nb_renouvellements || 0);

    const wf = $("d-filleuls");
    wf.innerHTML = filleuls.length ? filleuls.map((f) =>
      '<div class="ligne"><div><b>' + esc(f.masque) + '</b><br><span style="color:var(--texte3);font-size:11px">' +
      (f.actif ? "jusqu'au " + dateFr(f.fin) : "inactif · inscrit le " + dateFr(f.inscrit_le)) +
      '</span></div><span class="badge ' + (f.actif ? "actif" : "inactif") + '">' +
      (f.actif ? "Actif" : "Inactif") + "</span></div>").join("")
      : '<div class="vide">Personne encore via votre lien — partagez-le !</div>';

    const hist = st.historique || [];
    $("d-historique").innerHTML = hist.length ? hist.map((h) =>
      '<div class="ligne"><div>' + (h.type === "premiere" ? "1re activation" : "Renouvellement") +
      '<br><span style="color:var(--texte3);font-size:11px">' + dateFr(h.date) + '</span></div>' +
      '<div style="text-align:right"><b style="color:var(--vert)">+' + fcfa(h.montant) + ' F</b><br>' +
      '<span class="badge ' + (h.statut === "paye" ? "paye" : "attente") + '">' +
      (h.statut === "paye" ? "Payé" : h.statut === "annule" ? "Annulé" : "Dû") + "</span></div></div>").join("")
      : '<div class="vide">Aucun gain pour l\'instant.</div>';

    /* Message de partage 100 % dynamique : prix, promo (prix barré + date de
       fin) et réduction viennent de la table parametres — jamais codés en dur. */
    const pa = prixAffiche();
    const reduc = PARAM.affiliation.reduction_fcfa;
    let texte = "📊 Pronos Foot — analyses et conseils de matchs de foot, chiffres vérifiés (pas de paris, 18+).\n";
    if (pa.barre) {
      texte += "🔥 PROMO : " + fcfa(pa.prix) + " F le mois au lieu de " + fcfa(pa.barre) +
        " F, jusqu'au " + dateFr(pa.jusquau) + " !\n";
    } else {
      texte += "Abonnement " + fcfa(pa.prix) + " F / 30 jours.\n";
    }
    texte += "🎁 " + fcfa(reduc) + " F de réduction sur ton 1er mois avec mon code " + st.code + " :\n" + st.lien;
    $("d-whatsapp").href = "https://wa.me/?text=" + encodeURIComponent(texte);
  }

  function copier(texte, ouMsg) {
    (navigator.clipboard ? navigator.clipboard.writeText(texte) : Promise.reject())
      .then(() => msg(ouMsg, "Copié ✓", "ok"))
      .catch(() => msg(ouMsg, "Copie impossible — sélectionnez le texte manuellement.", "erreur"));
  }
  $("d-copier-code").onclick = () => ETAT.stats && copier(ETAT.stats.code, "d-msg");
  $("d-copier-lien").onclick = () => ETAT.stats && copier(ETAT.stats.lien, "d-msg");
  $("d-tel-btn").onclick = async () => {
    $("d-tel-btn").disabled = true;
    const r = await SB.rpc("maj_tel_affilie", { p_telephone: $("d-tel").value.trim() });
    $("d-tel-btn").disabled = false;
    msg("d-tel-msg", !r.error && r.data && r.data.ok ? "Numéro enregistré ✓" : "Enregistrement impossible.",
      !r.error && r.data && r.data.ok ? "ok" : "erreur");
  };

  /* ------------------------------------------------------------------ admin */
  async function chargerAdmin() {
    chargerTarifs();
    const r = await SB.rpc("liste_affilies", { p_statut: null });
    if (r.error) {
      $("o-attente").innerHTML = '<div class="vide">' +
        (erreurTexte(r.error) === "SQL_MISSING" ? "SQL non appliqué — collez affilies.sql dans Supabase." : erreurTexte(r.error)) + "</div>";
      $("o-tous").innerHTML = "";
      return;
    }
    const tous = ((r.data || {}).affilies) || [];
    const attente = tous.filter((a) => a.statut === "en_attente");
    $("o-attente").innerHTML = attente.length ? attente.map((a) => ligneAdmin(a, true)).join("")
      : '<div class="vide">Aucune demande en attente.</div>';
    $("o-tous").innerHTML = tous.length ? tous.map((a) => ligneAdmin(a, false)).join("")
      : '<div class="vide">Aucun affilié.</div>';
    tous.forEach((a) => {
      const ap = $("ap-" + a.id), su = $("su-" + a.id), pa = $("pa-" + a.code);
      if (ap) ap.onclick = async () => { await SB.rpc("approuver_affilie", { p_id: a.id }); await chargerAdmin(); };
      if (su) su.onclick = async () => {
        if (!confirm("Suspendre " + a.code + " ? Son code ne validera plus rien.")) return;
        await SB.rpc("suspendre_affilie", { p_id: a.id }); await chargerAdmin();
      };
      if (pa) pa.onclick = async () => {
        if (!confirm("Confirmer le paiement MoMo de " + fcfa(a.gains_dus) + " F à " + a.code + " puis marquer payé ?")) return;
        await SB.rpc("marquer_gains_payes", { p_code: a.code }); await chargerAdmin();
      };
    });
  }
  function ligneAdmin(a, estAttente) {
    const badge = a.statut === "actif" ? '<span class="badge actif">Actif</span>'
      : a.statut === "suspendu" ? '<span class="badge inactif">Suspendu</span>'
      : '<span class="badge attente">En attente</span>';
    const du = Number(a.gains_dus) || 0;
    return '<div class="ligne" style="flex-wrap:wrap">' +
      '<div style="min-width:60%"><b>' + esc(a.code) + '</b> ' + badge +
      '<br><span style="color:var(--texte3);font-size:11px">' +
      esc((a.prenom || "") + " " + (a.nom || "")) + " · " + esc(a.email || "") +
      '<br>MoMo : ' + esc(a.telephone_momo || "—") + " · " + (a.nb_filleuls || 0) + " filleul(s)" +
      '<br>Gains dus : <b style="color:var(--or)">' + fcfa(du) + ' F</b></span></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      (estAttente ? '<button id="ap-' + a.id + '" class="btn vert petit" type="button">Approuver</button>' : "") +
      (du >= seuilPaiement() ? '<button id="pa-' + esc(a.code) + '" class="btn petit" type="button">Marquer payé</button>' : "") +
      (a.statut === "actif" ? '<button id="su-' + a.id + '" class="btn secondaire petit" type="button">Suspendre</button>' : "") +
      "</div></div>";
  }
  $("o-rafraichir").onclick = () => chargerAdmin();

  /* Tarifs & promotion — formulaire opérateur (table `parametres`). */
  function chargerTarifs() {
    const v = (id, val) => { const el = $(id); if (el) el.value = val ?? ""; };
    v("t-prix", PARAM.prix.mensuel_fcfa);
    v("t-seuil", PARAM.affiliation.seuil_paiement_fcfa);
    v("t-promo-prix", PARAM.promo.prix_fcfa);
    v("t-promo-date", PARAM.promo.jusquau ? String(PARAM.promo.jusquau).slice(0, 10) : "");
    v("t-reduc", PARAM.affiliation.reduction_fcfa);
    v("t-c1", PARAM.affiliation.commission_premiere);
    v("t-c2", PARAM.affiliation.commission_renouvellement);
    const on = $("t-promo-on"); if (on) on.checked = !!PARAM.promo.actif;
  }
  const tSave = $("t-save");
  if (tSave) tSave.onclick = async () => {
    const ent = (id) => { const el = $(id); const n = el && el.value !== "" ? parseInt(el.value, 10) : NaN; return isNaN(n) ? null : n; };
    const prix = ent("t-prix"), pp = ent("t-promo-prix");
    const on = $("t-promo-on") && $("t-promo-on").checked;
    const jusquau = $("t-promo-date") ? $("t-promo-date").value : null;
    if (!prix || prix <= 0) { msg("t-msg", "Il faut un prix d'abonnement valide (ex. 2500).", "erreur"); return; }
    if (on && (!pp || pp <= 0 || pp >= prix || !jusquau)) {
      msg("t-msg", "Promo invalide : le prix promo doit être entre 1 et " + (prix - 1) +
        " F, avec une date de fin.", "erreur"); return;
    }
    tSave.disabled = true; msg("t-msg", "Enregistrement…");
    const aff = Object.assign({}, PARAM.affiliation);
    ["reduction_fcfa:t-reduc", "commission_premiere:t-c1", "commission_renouvellement:t-c2", "seuil_paiement_fcfa:t-seuil"]
      .forEach((pair) => { const [cle, id] = pair.split(":"); const n = ent(id); if (n != null && n >= 0) aff[cle] = n; });
    try {
      const appels = [
        ["prix", Object.assign({}, PARAM.prix, { mensuel_fcfa: prix })],
        ["promo", { actif: on, prix_fcfa: on ? pp : null, jusquau: on ? jusquau : null }],
        ["affiliation", aff],
      ];
      for (const [cle, valeur] of appels) {
        const r = await SB.rpc("maj_parametres", { p_cle: cle, p_valeur: valeur });
        if (r.error) throw r.error;
        if (!(r.data && r.data.ok)) throw new Error((r.data && r.data.erreur) || "refusé");
      }
      await chargeParametres();
      chargerTarifs(); majTextesPalier();
      msg("t-msg", "Tarifs enregistrés ✓ — la vitrine et les messages de partage sont à jour.", "ok");
    } catch (e) {
      const t = String((e && e.message) || e);
      msg("t-msg", /42883|function public\.maj_parametres|parametres/i.test(t)
        ? "Il faut d'abord coller parametres.sql dans Supabase → SQL Editor → Run."
        : "Enregistrement refusé : " + t.slice(0, 160), "erreur");
    }
    tSave.disabled = false;
  };

  /* -------------------------------------------------------------- déconnexion */
  async function quitter() {
    await SB.auth.signOut();
    ETAT.stats = null;
    ["i-prenom", "i-nom", "i-tel", "i-email", "i-mdp", "c-email", "c-mdp"].forEach((id) => { if ($(id)) $(id).value = ""; });
    modeFinalisation(false);
    montrer("auth");
  }
  ["a-quitter", "d-quitter", "o-quitter", "e-quitter"].forEach((id) => { if ($(id)) $(id).onclick = quitter; });

  /* ------------------------------------------------------------------ divers */
  if (CFG.WHATSAPP_AIDE) {
    $("f-whatsapp").href = "https://wa.me/" + String(CFG.WHATSAPP_AIDE).replace(/[^0-9]/g, "");
  }
  SB.auth.onAuthStateChange(() => { /* demarrer() est rappelé explicitement après chaque action */ });
  demarrer();
})();
