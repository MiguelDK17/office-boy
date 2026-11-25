/** Valida os dados sensíveis usados no envio final de uma candidatura. */

export interface DadosCandidaturaParaEnvio {
  cpf: unknown;
  pretensaoSalarial: unknown;
}

export interface ResultadoValidacaoCandidatura {
  valido: boolean;
  erros: string[];
}

function somenteDigitos(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

/** Valida CPF com dígitos verificadores, rejeitando sequências repetidas. */
export function cpfValido(valor: unknown): boolean {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculaDigito = (tamanho: number): number => {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return calculaDigito(9) === Number(cpf[9]) && calculaDigito(10) === Number(cpf[10]);
}

/** Aceita formatos humanos, mas nunca zero, vazio ou respostas de negociação. */
export function pretensaoSalarialValida(valor: unknown): boolean {
  const texto = String(valor ?? '').trim().toLocaleLowerCase('pt-BR');
  if (!texto || /a\s+combinar|negoci[aá]vel|n[aã]o\s+informad[oa]/i.test(texto)) return false;
  const normalizado = texto.replace(/r\$|\s/g, '').replace(/\./g, '').replace(',', '.');
  const numero = Number(normalizado.replace(/[^\d.-]/g, ''));
  return Number.isFinite(numero) && numero > 0;
}

export function validarDadosCandidatura(
  dados: DadosCandidaturaParaEnvio,
): ResultadoValidacaoCandidatura {
  const erros: string[] = [];
  if (!cpfValido(dados.cpf)) {
    erros.push('CPF ausente ou inválido — informe o CPF real, nunca "a combinar".');
  }
  if (!pretensaoSalarialValida(dados.pretensaoSalarial)) {
    erros.push('Pretensão salarial ausente, zero ou inválida — informe um valor positivo, nunca "0" ou "a combinar".');
  }
  return { valido: erros.length === 0, erros };
}
