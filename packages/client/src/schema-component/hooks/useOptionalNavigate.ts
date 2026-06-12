import { useNavigate as useRouterNavigate } from 'react-router-dom';

const noopNavigate = () => {};

export function useOptionalNavigate() {
  try {
    return useRouterNavigate();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('useNavigate() may be used only in the context of a <Router>')
    ) {
      return noopNavigate;
    }
    throw error;
  }
}
