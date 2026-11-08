// Prestataire de TEST : aucun argent ne bouge. Sert à vérifier tout le parcours.
// Astuce : un compte qui se termine par 0000 est refusé, pour tester l'échec.
module.exports = {
  name: 'sandbox',
  async send(t) {
    if (/0000$/.test(String(t.account).replace(/\s/g, ''))) return { status: 'failed', reason: 'Compte refusé (test)' };
    return { status: 'processing', providerRef: 'SBX-' + t.id.slice(0, 8) };
  },
  // Dépôt (cash-in) : l'argent entre sur le solde du client.
  async cashIn(t) {
    if (/0000$/.test(String(t.account).replace(/\s/g, ''))) return { status: 'failed', reason: 'Paiement refusé (test)' };
    return { status: 'processing', providerRef: 'SBX-IN-' + t.id.slice(0, 8) };
  },
  // Retrait (cash-out) : l'argent sort du solde vers le mobile money, la banque ou une agence.
  async cashOut(t) {
    if (/0000$/.test(String(t.account).replace(/\s/g, ''))) return { status: 'failed', reason: 'Compte refusé (test)' };
    return { status: 'processing', providerRef: 'SBX-OUT-' + t.id.slice(0, 8) };
  },
  async status(t) {
    if (t.status === 'failed') return 'failed';
    return Date.now() - t.createdAt < 5000 ? 'processing' : 'paid';
  }
};
