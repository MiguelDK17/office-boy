// IDs dos sites — UUID aleatório, gerado uma única vez e persistido no
// sites.json. Sem id, qualquer rota precisaria identificar o site pelo nome,
// que é texto livre (pode repetir, mudar de caixa, ganhar espaços...).
//
// Função pura: não lê nem grava arquivo (quem persiste é o sites-api.ts).

import { randomUUID } from 'crypto';

/** UUID v4 — ids de outros formatos são tratados como inválidos e regenerados. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SiteComId {
  id?: string;
  nome?: string;
  [chave: string]: unknown;
}

/**
 * Garante um id em cada site:
 *  - id existente e único é preservado;
 *  - id vazio, inválido ou repetido recebe um UUID novo.
 * Não altera nenhum outro campo, nem a ordem dos sites/objetos.
 */
export function garantirIdsSites<T extends SiteComId>(
  sites: T[],
): { sites: T[]; mudou: boolean } {
  const vistos = new Set<string>();
  let mudou = false;

  const resultado = sites.map((site) => {
    const atual = typeof site.id === 'string' ? site.id.trim() : '';
    if (atual && UUID_V4.test(atual) && !vistos.has(atual)) {
      vistos.add(atual);
      if (atual !== site.id) {
        mudou = true;
        return { ...site, id: atual };
      }
      return site;
    }
    const id = randomUUID();
    vistos.add(id);
    mudou = true;
    // Spread mantém a ordem original das chaves; id entra por último.
    return { ...site, id };
  });

  return { sites: resultado, mudou };
}
