import axios from 'axios';
import { vi } from 'vitest';

import { APIClient } from '../APIClient';

describe('APIClient', () => {
  describe('axios', () => {
    it('case 1', () => {
      const apiClient = new APIClient();
      expect(apiClient.axios).toBeDefined();
      expect(typeof apiClient.axios).toBe('function');
      expect(typeof apiClient.axios.request).toBe('function');
    });

    it('case 2', () => {
      const apiClient = new APIClient({
        baseURL: 'http://localhost/api/',
      });
      expect(apiClient.axios.defaults.baseURL).toBe('http://localhost/api/');
    });

    it('case 3', () => {
      const instance = axios.create();
      const apiClient = new APIClient(instance);
      expect(apiClient.axios).toBe(instance);
    });
  });

  test('should reset role when role is not found', async () => {
    const instance = axios.create();
    instance.interceptors.response.use(
      (response) => response,
      (error) => {
        error = {
          response: {
            data: {
              errors: [
                {
                  code: 'ROLE_NOT_FOUND_ERR',
                },
              ],
            },
          },
        };
        throw error;
      },
    );
    const apiClient = new APIClient(instance);
    apiClient.app = {} as any;
    apiClient.notification = {
      error: vi.fn(),
      success: vi.fn(),
    };
    const reloadLocation = vi.spyOn(apiClient, 'reloadLocation').mockImplementation(() => {});
    apiClient.auth.setRole('not-found');
    expect(apiClient.auth.role).toBe('not-found');
    try {
      await apiClient.request({
        method: 'GET',
        url: '/api/test',
      });
    } catch (err) {
      expect(err).toBeDefined();
      expect(err.response.data.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    }
    expect(apiClient.auth.role).toBeFalsy();
    expect(reloadLocation).toHaveBeenCalledTimes(1);
  });

  test('should include X-Tenant-Id header when current tenant id is set', () => {
    const apiClient = new APIClient();
    apiClient.app = { getName: () => 'main' } as any;
    apiClient.storage.setItem('current_tenant_id', 'tenant-a');

    const headers = apiClient.getHeaders();

    expect(headers['X-Tenant-Id']).toBe('tenant-a');
    expect(headers['X-Tenant']).toBeUndefined();
    expect(headers['X-App']).toBe('main');
  });
});
