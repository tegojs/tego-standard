export default {
  openapi: '3.0.3',
  info: {
    title: 'TachyBase API documentation',
    description: '',
    contact: {
      url: 'https://github.com/tegojs/tego-standard/issues',
    },
    license: {
      name: 'All packages are Apache 2.0 licensed.',
      url: 'https://github.com/tegojs/tego-standard#license',
    },
  },
  components: {
    securitySchemes: {
      'api-key': {
        type: 'http',
        scheme: 'bearer',
      },
    },
    schemas: {
      error: {
        type: 'object',
        properties: {
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                message: {
                  description: '错误信息',
                  type: 'string',
                },
              },
            },
          },
        },
      },
    },
  },
  security: [
    {
      'api-key': [],
    },
  ],
};
