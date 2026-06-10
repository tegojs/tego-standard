module.exports = {
  name: 'replies',
  fields: [
    {
      type: 'string',
      name: 'content',
    },
    {
      type: 'belongsTo',
      name: 'comment',
    },
  ],
};
