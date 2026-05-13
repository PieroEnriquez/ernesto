import { vi } from 'vitest';
import { Ernesto } from '../Ernesto';
import { SkillRegistry } from '../skill-registry';
import { createTestSkill, createTestTool } from './helpers';

describe('Ernesto', () => {
  const mockTypesense = {} as any;

  describe('constructor', () => {
    it('registers skills directly when skills provided', () => {
      const skill1 = createTestSkill({ name: 'test-skill-1' });
      const skill2 = createTestSkill({ name: 'test-skill-2' });

      const ernesto = new Ernesto({
        skills: [skill1, skill2],
        typesense: mockTypesense,
      });

      expect(ernesto.skills.get('test-skill-1')).toBe(skill1);
      expect(ernesto.skills.get('test-skill-2')).toBe(skill2);
    });

    it('stores and provides access to soul via getter', () => {
      const soul = { name: 'TestBot', persona: 'A helpful test bot' };
      const ernesto = new Ernesto({ soul, typesense: mockTypesense });
      expect(ernesto.soul).toBe(soul);
    });

    it('accepts injected SkillRegistry', () => {
      const registry = new SkillRegistry();
      const skill = createTestSkill({ name: 'injected-skill' });
      registry.register(skill);

      const ernesto = new Ernesto({
        skillRegistry: registry,
        typesense: mockTypesense,
      });

      expect(ernesto.skills.get('injected-skill')).toBe(skill);
    });
  });

  describe('accessors', () => {
    it('.skills returns SkillRegistry instance', () => {
      const ernesto = new Ernesto({ typesense: mockTypesense });
      expect(ernesto.skills).toBeDefined();
      expect(ernesto.skills).toBeInstanceOf(SkillRegistry);
    });
  });

  describe('toJSON', () => {
    it('returns serializable ErnestoSnapshot with correct fields', () => {
      const tool = createTestTool({ name: 'test-tool' });
      const skill = createTestSkill({ name: 'test-skill', tools: [tool] });
      const soul = { name: 'TestBot', persona: 'A helpful test bot' };

      const ernesto = new Ernesto({
        skills: [skill],
        soul,
        typesense: mockTypesense,
      });

      const snapshot = ernesto.toJSON();

      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.skills[0].name).toBe('test-skill');
      expect(snapshot.toolCount).toBe(1);
      expect(snapshot.soul).toBe(soul);
    });

    it('handles missing optional fields', () => {
      const ernesto = new Ernesto({ typesense: mockTypesense });
      const snapshot = ernesto.toJSON();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.toolCount).toBe(0);
      expect(snapshot.soul).toBeNull();
    });
  });
});
