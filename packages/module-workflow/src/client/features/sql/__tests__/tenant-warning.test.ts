import SQLInstruction from '../SQLInstruction';

describe('workflow SQL instruction tenant warning', () => {
  it('should not expose tenant isolation warning by default', () => {
    const instruction = new SQLInstruction();

    expect(instruction.fieldset.sql.description).toBeUndefined();
  });
});
