import { useBlockRequestContext } from '../../../block-provider/BlockRequestContext';

export const useBlockCollection = () => {
  const ctx = useBlockRequestContext();
  const name: string = ctx.props?.collection || ctx.props?.resource;

  return { name };
};
