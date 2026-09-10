# Admin dynamique : prix, promotions, scores en direct

Rien n'est codé en dur. Ce document explique où chaque réglage se change et
ce qui se passe côté visiteur.

## 1) Les prix et la promotion

**Où les changer** : espace affilié → connexion avec le compte opérateur
(operateur@pronos-foot.bj) → carte **« Tarifs & promotion »**.

Champs disponibles :

| Champ | Effet |
| --- | --- |
| Prix de l'abonnement (FCFA / 30 j) | Prix normal affiché partout |
| Période de promotion active | Case à cocher : allume/éteint la promo |
| Prix promo (FCFA) | Le prix payé pendant la promo |
| Jusqu'au (inclus) | Date de fin ; passée cette date, la promo s'éteint toute seule |
| Réduction filleul | Remise annoncée dans le message de partage des affiliés |
| Seuil de paiement des gains | Palier avant de payer un affilié (bouton « Marquer payé ») |
| Commission 1re activation | Gain de l'affilié sur un nouveau client |
| Commission renouvellement | Gain de l'affilié sur un mois renouvelé |

**Ce que le visiteur voit** : sur `vitrine/paiement.html`, le prix de la maquette
(5 000 FCFA écrit en dur dans le HTML) est remplacé à l'affichage par le vrai
prix. Si une promotion est active, une bande s'ajoute en haut de la page :
« 🔥 PROMOTION : 2 000 FCFA / 30 jours ~~2 500 FCFA~~ — jusqu'au 30 septembre inclus ».
L'ancien prix est barré, la date est écrite en clair.

**Ce que l'affilié voit** : son bouton « Partager sur WhatsApp » compose le
message avec les chiffres du moment (promo + date de fin si active, sinon prix
normal, + sa réduction).

**Côté base** : table `parametres` (3 clés : `prix`, `promo`, `affiliation`),
lecture publique, écriture uniquement via `maj_parametres()` réservée à
l'opérateur. Le déclencheur qui calcule les gains lit désormais ces valeurs :
changer une commission s'applique aux activations suivantes sans retoucher la base.

Garde-fous : prix promo obligatoire entre 1 et (prix normal − 1), date de fin
obligatoire, clés inconnues refusées.

**Si `parametres.sql` n'est pas encore collé** : aucun message d'erreur, les
valeurs par défaut du barème validé sont utilisées (2 500 F / réduction 500 /
commissions 1 000 et 500 / seuil 2 500).

## 2) Scores en direct toutes les 30 minutes

La demande était « rafraîchir les scores toutes les 30 min si le quota le
permet ». Réponse : **oui, et ça ne consomme aucun quota.**

Le rafraîchissement se fait dans le navigateur du visiteur, en appelant ESPN
directement (`site.api.espn.com`, publique, sans clé, en-tête
`access-control-allow-origin: *` vérifié le 10/09). Coût : 0 minute GitHub
Actions, 0 crédit The Odds API.

Comportement : premier passage 4 s après l'affichage, puis toutes les
30 minutes, plus à chaque retour sur l'onglet. Un badge apparaît sous le match
concerné :

- `⚽ direct 2-1 · 67'` pendant le match ;
- `⚽ terminé 2-1 (validation en attente)` à la fin ;
- `coup d'envoi 20:45` avant.

Limites honnêtes :

- **C'est de l'affichage, pas de la validation.** Le verdict officiel (✓ touchée /
  ✗ manquée, coupons, statistiques du bilan) reste calculé par le robot, chaque
  heure, dans la base. Le badge live ne remplace jamais ce verdict.
- Seuls les matchs **du jour** et **déjà résolus comme non joués** sont suivis.
- Le nom des équipes vient de football-data.co.uk côté base et d'ESPN côté live :
  un rapprochement flou est fait (suffixes « FC », « United », « Town »… retirés,
  accents ignorés). Testé le 10/09 sur les 3 derniers jours réels :
  **13 sélections sur 13 retrouvées**. Un match non reconnu reste simplement
  sans badge — il n'affiche jamais un faux score.
- Si ESPN ne répond pas ou si la page est fermée, rien ne se passe : le prochain
  passage horaire du robot remet tout à jour de toute façon.

## 3) Ce qui reste à faire

1. Coller `supabase/parametres.sql` dans Supabase → SQL Editor → Run (1 min,
   script idempotent, à passer après `affilies.sql`).
2. Pousser : dépôt `affilies` (nouveau) + patch vitrine. En attente du jeton
   d'accès GitHub.
3. « Buts d'affilée » : piste confirmée — ESPN expose les buts minutés dans
   `summary.keyEvents` (testé le 10/09 sur AEK Athens – LASK : `21' | Goal -
   Free-kick | Goal! AEK Athens 1, LASK 0`). À traiter séparément : spéc +
   backtest avant tout code, comme le veut REGLES.md.
