# Passerelle v2 — comptes, registre des soldes, base de données (MODE TEST)

Aucun argent réel ne bouge : le prestataire de paiement est un simulateur (`sandbox.js`).

## Ce qui est inclus
- **Comptes** : inscription avec prénom, nom, numéro de téléphone, code reçu par SMS, puis code PIN à 4 chiffres.
- **Registre des soldes** : on n'écrit jamais un solde, seulement des mouvements (dépôt, débit d'envoi, remboursement…). Le solde est leur somme. Un même mouvement ne peut pas être écrit deux fois, et le solde ne peut pas passer sous zéro (testé avec 30 envois simultanés).
- **Base de données** : SQLite intégrée à Node (fichier `passerelle.db`, ou `DB_PATH`).
- **Sécurité** : PIN haché (scrypt), 5 mauvais PIN = compte verrouillé 15 min, codes SMS valables 5 min et 5 essais, clés d'idempotence (pas de doublon si on retouche le bouton), limitation du nombre de requêtes, jetons de session stockés hachés, plafonds par jour et par mois côté serveur.
- **Taux en direct** (parités fixes, BCE, marché) et **suivi des opérations** (en cours, reçu, refusé, avec remboursement).

## Lancer et tester
`npm start` puis http://localhost:3000   —   `npm test` lance 26 tests automatiques.
Render : Build `npm install`, Start `npm start` (Node 22.5 ou plus).

## Avant de passer en réel (à ne pas sauter)
1. **SMS** : sans la variable `SMS_PROVIDER`, le code est affiché à l'écran (mode test). Branchez un prestataire SMS dans `sms.js`, puis définissez `SMS_PROVIDER`.
2. **Persistance** : sur l'offre gratuite de Render, le disque est effacé à chaque redémarrage ou mise en veille : les comptes disparaissent. Il faut un disque persistant (offre payante) ou une base PostgreSQL.
3. **PIN** : 4 chiffres, c'est faible si la base fuit. Définissez `PIN_PEPPER` (texte secret long, variable d'environnement) et envisagez un PIN à 6 chiffres.
4. **Partenaire de paiement agréé** : remplacez `sandbox.js` (voir `template.js`) : `send`, `cashIn`, `cashOut`, `status`.
5. **Vérification d'identité (KYC)** : champ `kyc` prévu dans la base, mais aucune vérification n'est faite.
6. **Aspects légaux** : agrément, lutte anti-blanchiment, protection des données personnelles. À valider avec un professionnel.
