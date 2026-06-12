import { useNavigate as useRouterNavigate } from 'react-router-dom';

const noopNavigate = () => {};

export function useOptionalNavigate() {
  try {
    return useRouterNavigate();
  } catch {
    return noopNavigate;
  }
}
