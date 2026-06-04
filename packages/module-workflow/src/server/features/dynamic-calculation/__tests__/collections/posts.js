module.exports = {
  name: 'posts',
  fields: [
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'boolean',
      name: 'published',
      defaultValue: false,
    },
    {
      type: 'integer',
      name: 'read',
      defaultValue: 0,
    },
    {
      type: 'json',
      name: 'category',
    },
    {
      type: 'integer',
      name: 'categoryId',
    },
    {
      type: 'hasMany',
      name: 'comments',
    },
    {
      type: 'belongsToMany',
      name: 'tags',
    },
  ],
};
