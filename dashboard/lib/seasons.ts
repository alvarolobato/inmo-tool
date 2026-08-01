export interface Season {
  code: string;
  label: string;
  from: string;
  to: string;
}

export function parseSeason(code: string): Season | null {
  const match = /^(PV|OI)(\d{2})$/i.exec(code.trim());
  if (!match) return null;

  const prefix = match[1].toUpperCase();
  const year = 2000 + parseInt(match[2], 10);
  const normalized = `${prefix}${match[2]}`;

  if (prefix === "PV") {
    return {
      code: normalized,
      label: `Primavera-Verano ${year}`,
      from: `${year}-02-01`,
      to: `${year}-08-31`,
    };
  }

  return {
    code: normalized,
    label: `Otoño-Invierno ${year}`,
    from: `${year}-09-01`,
    to: `${year + 1}-01-31`,
  };
}
