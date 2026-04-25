export type Lang = 'en' | 'de';
export const LANGS: readonly Lang[] = ['en', 'de'];

export const T: Record<Lang, Record<string, string>> = {
  en: {
    // ─── Nav ────────────────────────────────────────────────────────────
    'nav.products':      'Products',
    'nav.how':           'How it works',
    'nav.catch':         'The catch',
    'nav.compare':       'Compare',
    'nav.about':         'About',
    'nav.cta':           'START A PROJECT',

    // ─── Hero ───────────────────────────────────────────────────────────
    'hero.eyebrow':      'Index 0815 — the standard spec',
    'hero.h1':           'Standard software,<br />built to a <em class="hero__serif">higher</em> standard.',
    'hero.subhead':      'The CRUD apps, dashboards, storefronts and internal tools your team already knows how to describe — shipped in weeks, licensed under MIT, with every line of source code in your hands on day one.',
    'hero.cta1':         'Request a build →',
    'hero.cta2':         'Read the source ↗',

    // ─── Pillars ────────────────────────────────────────────────────────
    'pillars.h2':        'Three commitments. No footnotes,<br />no asterisks, no upsells.',
    'pillar.0.title':    'Open source',
    'pillar.0.body':     'Every repository is public, MIT-licensed, and yours to fork, audit, or walk away with. Your legal team can read the license on one page.',
    'pillar.1.title':    'Always free',
    'pillar.1.body':     '€0 to build, €0 to run, €0 to keep. No seat licenses, no usage caps, no pricing pages that require a demo call to decipher.',
    'pillar.2.title':    'Full transparency',
    'pillar.2.body':     "Public roadmap, public issue tracker, public commit history. You will never wonder what we did, why we did it, or when we'll do the next thing.",

    // ─── Managers ───────────────────────────────────────────────────────
    'managers.h2':       'The business case fits<br />on a single slide.',
    'cmp.bad.0':         '€12,000 / year / seat',
    'cmp.good.0':        '€0 forever',
    'cmp.bad.1':         'Months of procurement',
    'cmp.good.1':        'Ship in weeks',
    'cmp.bad.2':         'Black-box binaries',
    'cmp.good.2':        'Public source',
    'cmp.bad.3':         'Account manager calls',
    'cmp.good.3':        'Pull requests',
    'cmp.bad.4':         'Renegotiate every year',
    'cmp.good.4':        "It's just yours",
    'cmp.bad.5':         'Churn risk if they pivot',
    'cmp.good.5':        'Code outlives us',
    'roi.0.key':         'Risk',
    'roi.0.val':         'You own the code. If we disappear tomorrow, your software keeps running and any developer on earth can maintain it.',
    'roi.1.key':         'Speed',
    'roi.1.val':         "Standard scopes ship in 2–6 weeks. We don't reinvent CRUD — we've already built it a hundred times.",
    'roi.2.key':         'Cost',
    'roi.2.val':         'The software is free. You pay — optionally — for implementation, customisation, or an SLA. Walk away any time.',

    // ─── Catch ──────────────────────────────────────────────────────────
    'catch.h2':          '"What\'s the catch?"',
    'catch.intro':       "Fair question. We'd ask it too. Here's the honest answer — the same one we give in every first call, before anyone signs anything.",
    'faq.0.q':           'So how do you make money?',
    'faq.0.a':           'Implementation, customisation, training, and optional SLAs. The software is the free sample. Deep work on top of it is what we sell.',
    'faq.1.q':           "Is the software any good if it's free?",
    'faq.1.a':           "The same engineers write both the free core and the paid customisation. It's in our interest for the core to be production-grade.",
    'faq.2.q':           'What happens if you go out of business?',
    'faq.2.a':           'Nothing, for you. The code is MIT-licensed and mirrored across thousands of forks. Any developer can pick up maintenance.',
    'faq.3.q':           "Why 'always free' and not 'freemium'?",
    'faq.3.a':           "Because 'freemium' means 'we haven't shown you the price tag yet'. We'd rather be straight with you from the start.",

    // ─── Procedure ──────────────────────────────────────────────────────
    'procedure.h2':      'How a 0815 project runs.',
    'step.0.title':      'Scope',
    'step.0.body':       "One call. You describe the thing. We tell you if it's standard.",
    'step.1.title':      'Build',
    'step.1.body':       'We implement against an existing 0815 module. Daily public commits.',
    'step.2.title':      'Hand-off',
    'step.2.body':       'Repo transferred to your org. Docs, deploy scripts, training.',
    'step.3.title':      'Optional',
    'step.3.body':       "Keep us on retainer for changes and SLAs — or don't. Your call.",

    // ─── About ──────────────────────────────────────────────────────────
    'about.h2':          '"0815" is German for <em class="about__serif">run\u2011of\u2011the\u2011mill.</em> We think that\'s a compliment.',
    'about.body':        "Most business software is not special. It's forms, tables, reports, checkout flows, permissions. Industries have been solving these problems for thirty years and the answers are well known. We don't pretend otherwise. We build the standard thing, we build it fast, and we give you the keys.",
    'mission.body':      'Make standard business software a <span class="mission-card__accent">commodity</span>, not a <span class="mission-card__accent">cartel</span>.<br /><br />Charge for work, not for access.<br />Ship the source with the product.<br />Leave customers free to leave.',

    // ─── Contact ────────────────────────────────────────────────────────
    'contact.h2':        'Start a<br />project.',
    'contact.p1':        "Describe what you need in a paragraph. We'll reply within one business day with a candid yes, no, or here's-what-it-takes — and a fixed-price quote if the scope is standard.",
    'contact.p2':        "No NDAs to sign. No sales funnel. No calendar invite for a 45-minute discovery call before anyone answers a single question. Write to a human, get a human back.",
    'contact.meta.0':    'hello@0815software.com',
    'contact.meta.1':    'Linz, AT · CET',
    'contact.meta.2':    'github.com/0815software',
    'contact.meta.3':    '< 24h, weekdays',
    'contact.lbl.name':    'NAME',
    'contact.lbl.company': 'COMPANY',
    'contact.lbl.email':   'EMAIL',
    'contact.lbl.msg':     'WHAT DO YOU NEED?',
    'contact.ph.name':     'Jane Doe',
    'contact.ph.company':  'Acme GmbH',
    'contact.ph.email':    'jane@acme.com',
    'contact.ph.msg':      'A customer portal for order tracking…',
    'contact.submit':      'Send — reply in 1 business day →',

    // ─── Footer ─────────────────────────────────────────────────────────
    'footer.tagline':    'Standard software, built to a higher standard. Open source, always free, fully transparent — because the price of business software should be what it costs to build, not what the market will bear.',
    'footer.status':     '● ALL SYSTEMS OPEN',
  },

  de: {
    // ─── Nav ────────────────────────────────────────────────────────────
    'nav.products':      'Produkte',
    'nav.how':           'So funktionierts',
    'nav.catch':         'Der Haken',
    'nav.compare':       'Vergleich',
    'nav.about':         'Über uns',
    'nav.cta':           'PROJEKT STARTEN',

    // ─── Hero ───────────────────────────────────────────────────────────
    'hero.eyebrow':      'Index 0815 — die Standardspezifikation',
    'hero.h1':           'Standardsoftware,<br />auf <em class="hero__serif">höherem</em> Niveau gebaut.',
    'hero.subhead':      'Die CRUD-Apps, Dashboards, Shops und internen Tools, die dein Team bereits beschreiben kann — in Wochen geliefert, MIT-lizenziert, mit jeder Zeile Quellcode in deinen Händen ab Tag eins.',
    'hero.cta1':         'Build anfragen →',
    'hero.cta2':         'Quellcode lesen ↗',

    // ─── Pillars ────────────────────────────────────────────────────────
    'pillars.h2':        'Drei Versprechen. Keine Fußnoten,<br />keine Sternchen, keine Upsells.',
    'pillar.0.title':    'Open Source',
    'pillar.0.body':     'Jedes Repository ist öffentlich, MIT-lizenziert und gehört dir zum Forken, Prüfen oder Mitnehmen. Deine Rechtsabteilung kann die Lizenz auf einer Seite lesen.',
    'pillar.1.title':    'Immer kostenlos',
    'pillar.1.body':     '€0 zum Bauen, €0 zum Betreiben, €0 zum Behalten. Keine Platzlizenzen, keine Nutzungslimits, keine Preisseiten, die einen Demo-Call erfordern.',
    'pillar.2.title':    'Volle Transparenz',
    'pillar.2.body':     'Öffentliche Roadmap, öffentlicher Issue-Tracker, öffentliche Commit-Historie. Du wirst nie rätseln, was wir getan haben, warum und wann wir als Nächstes liefern.',

    // ─── Managers ───────────────────────────────────────────────────────
    'managers.h2':       'Der Business-Case passt<br />auf eine einzige Folie.',
    'cmp.bad.0':         '€12.000 / Jahr / Platz',
    'cmp.good.0':        '€0 für immer',
    'cmp.bad.1':         'Monate Beschaffungszeit',
    'cmp.good.1':        'In Wochen liefern',
    'cmp.bad.2':         'Black-Box-Binaries',
    'cmp.good.2':        'Öffentlicher Code',
    'cmp.bad.3':         'Account-Manager-Calls',
    'cmp.good.3':        'Pull Requests',
    'cmp.bad.4':         'Jedes Jahr neu verhandeln',
    'cmp.good.4':        'Gehört einfach dir',
    'cmp.bad.5':         'Abwanderungsrisiko bei Pivot',
    'cmp.good.5':        'Code überdauert uns',
    'roi.0.key':         'Risiko',
    'roi.0.val':         'Du besitzt den Code. Falls wir morgen verschwinden, läuft deine Software weiter und jeder Entwickler weltweit kann sie pflegen.',
    'roi.1.key':         'Tempo',
    'roi.1.val':         'Standardumfänge liefern wir in 2–6 Wochen. Wir erfinden CRUD nicht neu — wir haben es schon hundert Mal gebaut.',
    'roi.2.key':         'Kosten',
    'roi.2.val':         'Die Software ist kostenlos. Du zahlst — optional — für Implementierung, Anpassungen oder ein SLA. Jederzeit kündbar.',

    // ─── Catch ──────────────────────────────────────────────────────────
    'catch.h2':          '"Was ist der Haken?"',
    'catch.intro':       'Berechtigte Frage. Wir würden sie auch stellen. Hier ist die ehrliche Antwort — dieselbe, die wir in jedem ersten Gespräch geben, bevor irgendjemand etwas unterschreibt.',
    'faq.0.q':           'Womit verdient ihr dann Geld?',
    'faq.0.a':           'Implementierung, Anpassungen, Schulungen und optionale SLAs. Die Software ist das kostenlose Muster. Tiefgehende Arbeit darüber hinaus ist unser Geschäft.',
    'faq.1.q':           'Ist die Software gut, wenn sie kostenlos ist?',
    'faq.1.a':           'Dieselben Entwickler schreiben sowohl den kostenlosen Kern als auch die bezahlten Anpassungen. Es liegt in unserem Interesse, dass der Kern produktionsreif ist.',
    'faq.2.q':           'Was passiert, wenn ihr pleitegeht?',
    'faq.2.a':           'Für dich nichts. Der Code ist MIT-lizenziert und über tausende Forks gespiegelt. Jeder Entwickler kann die Wartung übernehmen.',
    'faq.3.q':           'Warum "immer kostenlos" und nicht "Freemium"?',
    'faq.3.a':           'Weil "Freemium" bedeutet: "Das Preisschild haben wir noch nicht gezeigt." Wir sind lieber von Anfang an ehrlich.',

    // ─── Procedure ──────────────────────────────────────────────────────
    'procedure.h2':      'So läuft ein 0815-Projekt ab.',
    'step.0.title':      'Scope',
    'step.0.body':       'Ein Gespräch. Du beschreibst das Vorhaben. Wir sagen dir, ob es Standard ist.',
    'step.1.title':      'Umsetzung',
    'step.1.body':       'Wir implementieren auf Basis eines bestehenden 0815-Moduls. Tägliche öffentliche Commits.',
    'step.2.title':      'Übergabe',
    'step.2.body':       'Repo wird in deine Org übertragen. Docs, Deploy-Skripte, Einweisung.',
    'step.3.title':      'Optional',
    'step.3.body':       'Behalte uns als Retainer für Änderungen und SLAs — oder nicht. Deine Entscheidung.',

    // ─── About ──────────────────────────────────────────────────────────
    'about.h2':          '"0815" steht für <em class="about__serif">Durchschnitt.</em> Wir sehen das als Kompliment.',
    'about.body':        'Die meiste Unternehmenssoftware ist nicht besonders. Es sind Formulare, Tabellen, Berichte, Checkout-Flows, Berechtigungen. Die Branche löst diese Probleme seit dreißig Jahren und die Antworten sind bekannt. Wir tun nicht so, als wäre das anders. Wir bauen das Standardding, wir bauen es schnell, und wir geben dir die Schlüssel.',
    'mission.body':      'Standardsoftware zur <span class="mission-card__accent">Ware</span> machen, nicht zum <span class="mission-card__accent">Kartell</span>.<br /><br />Für Arbeit berechnen, nicht für Zugang.<br />Quellcode mit dem Produkt liefern.<br />Kunden frei lassen zu gehen.',

    // ─── Contact ────────────────────────────────────────────────────────
    'contact.h2':        'Projekt<br />starten.',
    'contact.p1':        'Beschreibe in einem Absatz, was du brauchst. Wir antworten innerhalb eines Werktags mit einem ehrlichen Ja, Nein oder So-geht-es — und einem Festpreisangebot bei Standardumfang.',
    'contact.p2':        'Kein NDA zum Unterschreiben. Kein Sales-Funnel. Keine Kalendereinladung für ein 45-minütiges Discovery-Call, bevor jemand eine einzige Frage beantwortet. Schreib einem Menschen, bekomm einen Menschen zurück.',
    'contact.meta.0':    'hello@0815software.com',
    'contact.meta.1':    'Linz, AT · CET',
    'contact.meta.2':    'github.com/0815software',
    'contact.meta.3':    '< 24h, werktags',
    'contact.lbl.name':    'NAME',
    'contact.lbl.company': 'UNTERNEHMEN',
    'contact.lbl.email':   'E-MAIL',
    'contact.lbl.msg':     'WAS BRAUCHST DU?',
    'contact.ph.name':     'Max Mustermann',
    'contact.ph.company':  'Mustermann GmbH',
    'contact.ph.email':    'max@mustermann.de',
    'contact.ph.msg':      'Ein Kundenportal für die Auftragsverfolgung…',
    'contact.submit':      'Absenden — Antwort in 1 Werktag →',

    // ─── Footer ─────────────────────────────────────────────────────────
    'footer.tagline':    'Standardsoftware auf höherem Niveau. Open Source, immer kostenlos, vollkommen transparent — denn der Preis von Unternehmenssoftware sollte die Baukosten widerspiegeln, nicht das, was der Markt hergibt.',
    'footer.status':     '● ALLE SYSTEME OFFEN',
  },
};
