# Source code for brijeshbhakta.com

## Build this project

### Install jekyll

Ensure `jekyll` is installed:

```
gem install jekyll
```

If you need XCode dependencies, follow the [Jekyll installation guide](https://jekyllrb.com/docs/installation/). For Windows, follow the [Windows installation guide](https://jekyllrb.com/docs/windows/#installation).

Uncompiled [Jekyll](//jekyllrb.com) source code for [brijeshbhakta.com](//brijeshbhakta.com).

### Installing dependencies

This project makes use of `gulp` and `yarn`. First, you'll need to make sure you have them both installed:

```
npm install --g gulp
npm install --g yarn
```

Next, you'll need to `yarn install` the other dev-dependencies, run this from the `brijeshbhakta30.github.io` root folder:

```
cd brijeshbhakta30.github.io
yarn install
```

### Running the server

Gulp is setup to make it easier to run all the tasks, to run the project simply run:

```
yarn start
```

This will start serving the project from `localhost:4000`, with livereload functionality.

