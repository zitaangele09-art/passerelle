// Choix du prestataire : variable d'environnement PROVIDER (par défaut : sandbox).
// Pour router par mode de réception (ex. Wave au Sénégal, MTN MoMo au Bénin),
// modifiez providerFor() ci-dessous.
const registre = { sandbox: require('./sandbox') };
// registre.monpartenaire = require('./monpartenaire');

function providerFor(t) {
  const nom = process.env.PROVIDER || 'sandbox';
  const p = registre[nom];
  if (!p) throw new Error('Prestataire inconnu : ' + nom);
  return p;
}
module.exports = { providerFor };
