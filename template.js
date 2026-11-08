// Modèle pour brancher un vrai prestataire (Wave, Orange Money, MTN MoMo, Moov Money,
// ou un agrégateur agréé). Copiez ce fichier, par exemple en providers/monpartenaire.js,
// puis remplissez les deux fonctions avec l'API fournie par votre partenaire.
//
// send(t)   : crée l'envoi chez le partenaire. Renvoie { status, providerRef } ou { status:'failed', reason }.
// status(t) : renvoie 'processing' | 'paid' | 'failed' pour un envoi déjà créé.
//
// t contient : id, from, to, amount (montant débité hors frais), received (montant reçu),
// country, method, name, account, createdAt, providerRef.
//
// Rappel : les clés d'API vont dans des variables d'environnement, jamais dans le code.
module.exports = {
  name: 'monpartenaire',
  async send(t) { throw new Error('À implémenter avec l\'API du partenaire'); },
  async cashIn(t) { throw new Error('À implémenter : dépôt (carte, mobile money, virement)'); },
  async cashOut(t) { throw new Error('À implémenter : retrait (mobile money, virement, agence)'); },
  async status(t) { throw new Error('À implémenter avec l\'API du partenaire'); }
};
