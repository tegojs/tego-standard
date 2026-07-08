module.exports = {
  name: 'tags',
  fields: [
    {
      type: 'belongsToMany',
      name: 'posts',
    },
    {
      type: 'string',
      name: 'name',
    },
  ],
};
