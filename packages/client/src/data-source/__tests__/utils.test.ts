import { CollectionFieldInterface } from '../collection-field-interface/CollectionFieldInterface';
import { isTitleField } from '../utils';

describe('utils', () => {
  describe('isTitleField', () => {
    class Demo1FieldInterface extends CollectionFieldInterface {
      name = 'demo1';
      titleUsable = false;
    }
    class Demo2FieldInterface extends CollectionFieldInterface {
      name = 'demo2';
      titleUsable = true;
    }

    const fieldInterfaces = {
      demo1: new Demo1FieldInterface({} as any),
      demo2: new Demo2FieldInterface({} as any),
    };
    const dm = {
      collectionFieldInterfaceManager: {
        getFieldInterface: (name: string) => fieldInterfaces[name],
      },
    } as any;

    it('should return false when field is foreign key', () => {
      const field = {
        isForeignKey: true,
      };
      expect(isTitleField(dm, field)).toBeFalsy();
    });

    it('should return false when field interface is not title usable', () => {
      const field = {
        isForeignKey: false,
        interface: 'demo1',
      };
      expect(isTitleField(dm, field)).toBeFalsy();
    });

    it('should return true when field is not foreign key and field interface is title usable', () => {
      const field = {
        isForeignKey: false,
        interface: 'demo2',
      };
      expect(isTitleField(dm, field)).toBeTruthy();
    });
  });
});
