import type { Jurisdiction } from '@nexlegtiq/shared-types';

/**
 * Official legal sources searched first, by jurisdiction (D-256): legislation databases, official gazettes, courts.
 * Empty = the open web at once. shortcut: a curated list in code; move it to platform settings when admins need to edit it.
 */
export const LEGAL_SOURCES: Readonly<Record<Jurisdiction, readonly string[]>> = {
  PALESTINE: ['muqtafi.birzeit.edu', 'maqam.najah.edu', 'courts.gov.ps', 'moj.pna.ps'],
  JORDAN: ['lob.gov.jo', 'jc.jo', 'moj.gov.jo'],
  EGYPT: ['cc.gov.eg', 'moj.gov.eg'],
  SAUDI_ARABIA: ['laws.boe.gov.sa', 'moj.gov.sa'],
  UAE: ['uaelegislation.gov.ae', 'moj.gov.ae'],
  KUWAIT: ['moj.gov.kw'],
  QATAR: ['almeezan.qa'],
  OMAN: ['mjla.gov.om'],
  BAHRAIN: ['legalaffairs.gov.bh'],
  LEBANON: ['legiliban.ul.edu.lb'],
  IRAQ: ['moj.gov.iq'],
  MOROCCO: ['sgg.gov.ma'],
  USA: ['congress.gov', 'supremecourt.gov', 'uscourts.gov'],
  UK: ['legislation.gov.uk', 'caselaw.nationalarchives.gov.uk'],
  OTHER: [],
};

/** The jurisdiction in words, for the prompt. */
export const JURISDICTION_NAMES: Readonly<Record<Jurisdiction, string>> = {
  PALESTINE: 'Palestine',
  JORDAN: 'Jordan',
  EGYPT: 'Egypt',
  SAUDI_ARABIA: 'Saudi Arabia',
  UAE: 'the United Arab Emirates',
  KUWAIT: 'Kuwait',
  QATAR: 'Qatar',
  OMAN: 'Oman',
  BAHRAIN: 'Bahrain',
  LEBANON: 'Lebanon',
  IRAQ: 'Iraq',
  MOROCCO: 'Morocco',
  USA: 'the United States',
  UK: 'the United Kingdom',
  OTHER: 'the jurisdiction the question names',
};
