import { useResubmit } from '..';

// 重新发起
export function useActionResubmit() {
  const { setResubmit } = useResubmit();

  return {
    async run() {
      setResubmit(true);
    },
  };
}
