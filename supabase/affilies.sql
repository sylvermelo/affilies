-- ============================================================================
-- ESPACE AFFILIÉ — tables, journal des gains et fonctions sécurisées
-- ============================================================================
-- À coller dans : Dashboard Supabase → SQL Editor → New query → Run.
-- Script IDEMPOTENT : on peut le relancer sans rien casser.
--
-- Barème validé par l'utilisateur le 10/09/2026 :
--   · abonnement 2 500 FCFA / 30 jours ;
--   · via un affilié : réduction 500 F → le filleul paie 2 000 F ;
--   · 1re activation : affilié 1 000 F / propriétaire 1 000 F ;
--   · chaque renouvellement : affilié 500 F / propriétaire 2 000 F.
-- Règles : commission quand l'abonnement devient ACTIF (jamais à la simple
-- inscription) ; attribution à l'inscription (code_promo, déjà en place) ;
-- pas d'auto-commission ; paiement par palier de 2 500 F (manuel au début,
-- automatique via Moneroo payout plus tard).
--
-- S'appuie sur l'existant : table `partenaires` (codes PF-XXXXX), colonne
-- `abonnements.code_promo`, fonction `declarer_code_promo` (rls_partenaires.sql).
-- ============================================================================

-- ---------------------------------------------------------------- 1) partenaires : colonnes affilié
alter table public.partenaires add column if not exists user_id uuid references auth.users (id);
alter table public.partenaires add column if not exists email text;
alter table public.partenaires add column if not exists prenom text;
alter table public.partenaires add column if not exists telephone_momo text;
alter table public.partenaires add column if not exists approuve_le timestamptz;
-- statut ajouté SANS default pour ne pas écraser les vendeurs existants :
alter table public.partenaires add column if not exists statut text;
update public.partenaires
   set statut = case when actif then 'actif' else 'en_attente' end
 where statut is null;
alter table public.partenaires alter column statut set default 'en_attente';

create unique index if not exists partenaires_email_unique
  on public.partenaires (email) where email is not null;
create unique index if not exists partenaires_user_unique
  on public.partenaires (user_id) where user_id is not null;

-- L'affilié voit SA ligne (l'opérateur garde sa politique existante).
drop policy if exists "affilie_lit_sa_ligne" on public.partenaires;
create policy "affilie_lit_sa_ligne" on public.partenaires
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------- 2) journal des gains
create table if not exists public.gains_affilies (
  id              bigint generated always as identity primary key,
  code            text not null,             -- code affilié (PF-XXXXX)
  filleul_user_id uuid not null,             -- compte abonné parrainé
  type            text not null check (type in ('premiere', 'renouvellement')),
  montant         integer not null,          -- 1000 (première) / 500 (renouvellement)
  fin_cible       date not null,             -- échéance d'abonnement qui déclenche le gain
  statut          text not null default 'du' check (statut in ('du', 'paye', 'annule')),
  cree_le         timestamptz not null default now(),
  paye_le         timestamptz
);
create unique index if not exists gains_premiere_unique
  on public.gains_affilies (filleul_user_id) where type = 'premiere';
create unique index if not exists gains_renouvellement_unique
  on public.gains_affilies (filleul_user_id, fin_cible) where type = 'renouvellement';
create index if not exists gains_code on public.gains_affilies (code, statut);
alter table public.gains_affilies enable row level security;

-- Seul l'opérateur touche au journal (les affiliés passent par les fonctions).
drop policy if exists "operateur_gains" on public.gains_affilies;
create policy "operateur_gains" on public.gains_affilies
  for all to authenticated
  using (auth.email() = 'operateur@pronos-foot.bj')
  with check (auth.email() = 'operateur@pronos-foot.bj');

-- ---------------------------------------------------------------- 3) déclencheur : un gain par activation
-- Se déclenche quand l'échéance (fin) d'un abonnement MONTE et qu'un code
-- promo est attribué. Première activation → 1 000 F ; suivantes → 500 F.
create or replace function public.enregistrer_gain_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_montant int;
begin
  if tg_op = 'UPDATE' then
    if new.fin is not distinct from old.fin then return new; end if;  -- pas de changement d'échéance
    if new.fin <= old.fin then return new; end if;                    -- uniquement à la hausse
  end if;
  if new.code_promo is null then return new; end if;
  if new.fin < current_date then return new; end if;                  -- activation réelle seulement
  if coalesce(new.plan, '') = 'operateur' then return new; end if;
  -- anti-fraude : pas d'auto-commission (affilié = son propre filleul)
  if exists (select 1 from public.partenaires p
              where p.code = new.code_promo and p.user_id = new.user_id) then
    return new;
  end if;
  if exists (select 1 from public.gains_affilies g
              where g.filleul_user_id = new.user_id and g.type = 'premiere') then
    v_type := 'renouvellement'; v_montant := 500;
  else
    v_type := 'premiere'; v_montant := 1000;
  end if;
  insert into public.gains_affilies (code, filleul_user_id, type, montant, fin_cible)
  values (new.code_promo, new.user_id, v_type, v_montant, new.fin)
  on conflict do nothing;
  return new;
end
$$;
drop trigger if exists gain_activation on public.abonnements;
create trigger gain_activation
  after insert or update on public.abonnements
  for each row execute function public.enregistrer_gain_activation();

-- ---------------------------------------------------------------- 4) fonctions AFFILIÉ
-- 4a) Créer son compte affilié (après inscription e-mail + mot de passe).
create or replace function public.creer_compte_affilie(
  p_prenom text, p_nom text, p_telephone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(auth.email(), '')));
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- sans 0/O/1/I (lisibles au téléphone)
  v_code text;
  i int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'erreur', 'pas_connecte');
  end if;
  if v_email = 'operateur@pronos-foot.bj' then
    return jsonb_build_object('ok', false, 'erreur', 'interdit');
  end if;
  if exists (select 1 from public.partenaires where user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'erreur', 'deja_cree');
  end if;
  if exists (select 1 from public.partenaires where email = v_email) then
    return jsonb_build_object('ok', false, 'erreur', 'email_pris');
  end if;
  loop
    v_code := 'PF-';
    for i in 1..5 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.partenaires where code = v_code);
  end loop;
  insert into public.partenaires (code, nom, actif, statut, user_id, email, prenom, telephone_momo)
  values (v_code, btrim(coalesce(p_nom, '')), false, 'en_attente',
          auth.uid(), v_email, btrim(coalesce(p_prenom, '')), btrim(coalesce(p_telephone, '')));
  return jsonb_build_object('ok', true, 'code', v_code, 'statut', 'en_attente');
end
$$;

-- 4b) Tableau de bord de l'affilié connecté (profil + filleuls masqués + gains).
create or replace function public.mes_stats_affilie()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aff public.partenaires%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'erreur', 'pas_connecte');
  end if;
  select * into v_aff from public.partenaires where user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'erreur', 'pas_affilie');
  end if;
  return jsonb_build_object(
    'ok', true,
    'code', v_aff.code,
    'statut', coalesce(v_aff.statut, 'en_attente'),
    'prenom', v_aff.prenom,
    'nom', v_aff.nom,
    'email', v_aff.email,
    'telephone_momo', v_aff.telephone_momo,
    'lien', 'https://sylvermelo.github.io/vitrine/inscription.html?p=' || v_aff.code,
    'filleuls', coalesce((
      select jsonb_agg(jsonb_build_object(
               'masque', case
                 when a.email like '%@tel.pronos-foot.bj' then 'Compte téléphone'
                 else left(coalesce(a.email, '?'), 2) || '•••'
               end,
               'actif', a.fin >= current_date,
               'fin', a.fin,
               'inscrit_le', a.debut)
             order by a.debut desc)
      from public.abonnements a
      where a.code_promo = v_aff.code
        and coalesce(a.plan, '') <> 'operateur'), '[]'::jsonb),
    'gains_dus', coalesce((select sum(g.montant) from public.gains_affilies g
                            where g.code = v_aff.code and g.statut = 'du'), 0),
    'gains_payes', coalesce((select sum(g.montant) from public.gains_affilies g
                              where g.code = v_aff.code and g.statut = 'paye'), 0),
    'nb_premieres', coalesce((select count(*) from public.gains_affilies g
                               where g.code = v_aff.code and g.type = 'premiere'
                                 and g.statut <> 'annule'), 0),
    'nb_renouvellements', coalesce((select count(*) from public.gains_affilies g
                                     where g.code = v_aff.code and g.type = 'renouvellement'
                                       and g.statut <> 'annule'), 0),
    'historique', coalesce((
      select jsonb_agg(jsonb_build_object(
               'type', h.type, 'montant', h.montant,
               'statut', h.statut, 'date', h.date) order by h.date desc)
      from (select g2.type, g2.montant, g2.statut, g2.cree_le as date
            from public.gains_affilies g2
            where g2.code = v_aff.code
            order by g2.cree_le desc limit 15) h), '[]'::jsonb)
  );
end
$$;

-- 4c) Mettre à jour son numéro MoMo (seule colonne modifiable par l'affilié).
create or replace function public.maj_tel_affilie(p_telephone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'erreur', 'pas_connecte');
  end if;
  update public.partenaires
     set telephone_momo = btrim(coalesce(p_telephone, ''))
   where user_id = auth.uid();
  if found then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'erreur', 'pas_affilie');
end
$$;

-- ---------------------------------------------------------------- 5) fonctions OPÉRATEUR
-- 5a) Liste des affiliés (filtre par statut optionnel).
create or replace function public.liste_affilies(p_statut text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.email() is distinct from 'operateur@pronos-foot.bj' then
    return jsonb_build_object('ok', false, 'erreur', 'interdit');
  end if;
  return jsonb_build_object('ok', true, 'affilies', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'code', p.code, 'prenom', p.prenom, 'nom', p.nom,
             'email', p.email, 'telephone_momo', p.telephone_momo,
             'statut', p.statut, 'cree_le', p.cree_le, 'approuve_le', p.approuve_le,
             'nb_filleuls', (select count(*) from public.abonnements a
                              where a.code_promo = p.code and coalesce(a.plan,'') <> 'operateur'),
             'gains_dus', coalesce((select sum(g.montant) from public.gains_affilies g
                                     where g.code = p.code and g.statut = 'du'), 0))
           order by p.cree_le desc)
    from public.partenaires p
    where p.user_id is not null
      and (p_statut is null or p.statut = p_statut)), '[]'::jsonb));
end
$$;

-- 5b) Approuver (ou réactiver) un affilié.
create or replace function public.approuver_affilie(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.email() is distinct from 'operateur@pronos-foot.bj' then
    return jsonb_build_object('ok', false, 'erreur', 'interdit');
  end if;
  update public.partenaires
     set actif = true, statut = 'actif', approuve_le = now()
   where id = p_id;
  if found then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'erreur', 'introuvable');
end
$$;

-- 5c) Suspendre un affilié (son code ne valide plus rien : codes_promo filtre actif).
create or replace function public.suspendre_affilie(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.email() is distinct from 'operateur@pronos-foot.bj' then
    return jsonb_build_object('ok', false, 'erreur', 'interdit');
  end if;
  update public.partenaires
     set actif = false, statut = 'suspendu'
   where id = p_id;
  if found then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'erreur', 'introuvable');
end
$$;

-- 5d) Marquer les gains d'un affilié comme payés (après virement MoMo manuel).
create or replace function public.marquer_gains_payes(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if auth.email() is distinct from 'operateur@pronos-foot.bj' then
    return jsonb_build_object('ok', false, 'erreur', 'interdit');
  end if;
  update public.gains_affilies
     set statut = 'paye', paye_le = now()
   where code = upper(btrim(coalesce(p_code, ''))) and statut = 'du';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'nb', n);
end
$$;

-- ---------------------------------------------------------------- 6) droits
revoke all on function public.creer_compte_affilie(text, text, text) from public;
grant execute on function public.creer_compte_affilie(text, text, text) to authenticated;
revoke all on function public.mes_stats_affilie() from public;
grant execute on function public.mes_stats_affilie() to authenticated;
revoke all on function public.maj_tel_affilie(text) from public;
grant execute on function public.maj_tel_affilie(text) to authenticated;
revoke all on function public.liste_affilies(text) from public;
grant execute on function public.liste_affilies(text) to authenticated;
revoke all on function public.approuver_affilie(bigint) from public;
grant execute on function public.approuver_affilie(bigint) to authenticated;
revoke all on function public.suspendre_affilie(bigint) from public;
grant execute on function public.suspendre_affilie(bigint) to authenticated;
revoke all on function public.marquer_gains_payes(text) from public;
grant execute on function public.marquer_gains_payes(text) to authenticated;

-- ============================================================================
-- FIN — Vérification rapide :
--   · Table Editor : `gains_affilies` créée ; `partenaires` a les nouvelles colonnes.
--   · Un compte existant peut appeler mes_stats_affilie() → {"ok":false,"erreur":"pas_affilie"}.
-- Remarques honnêtes :
--   · Un vendeur ajouté ANCIENNEMENT par l'opérateur (sans compte) reste géré
--     comme avant ; il n'apparaît pas dans l'espace affilié.
--   · Si un client est activé AVANT de déclarer son code, la première
--     activation n'est pas rétro-comptée ; son prochain renouvellement, si.
--   · Activation multi-mois d'un coup = comptée comme UN renouvellement (500 F).
-- ============================================================================
