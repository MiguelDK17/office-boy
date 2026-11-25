import { describe, expect, it } from 'vitest';
import { cpfValido, pretensaoSalarialValida, validarDadosCandidatura } from '../src/validacao-candidatura';

describe('validação dos dados no envio da candidatura', () => {
  it('aceita CPF válido formatado e pretensão positiva', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(pretensaoSalarialValida('R$ 8.000,00')).toBe(true);
    expect(validarDadosCandidatura({ cpf: '529.982.247-25', pretensaoSalarial: '8000' }).valido).toBe(true);
  });

  it.each(['0', 'R$ 0,00', '', 'A combinar', 'negociável'])('rejeita pretensão inválida: %s', (valor) => {
    expect(pretensaoSalarialValida(valor)).toBe(false);
  });

  it('rejeita CPF mascarado como texto ou com dígito inválido', () => {
    expect(cpfValido('a combinar')).toBe(false);
    expect(cpfValido('529.982.247-24')).toBe(false);
    expect(validarDadosCandidatura({ cpf: 'a combinar', pretensaoSalarial: '0' }).erros).toHaveLength(2);
  });
});
