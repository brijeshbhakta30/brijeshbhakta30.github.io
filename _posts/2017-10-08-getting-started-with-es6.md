---
layout: post
permalink: /getting-started-with-es6
title: "Getting started with ES6"
path: 2017-10-08-getting-started-with-es6.md
tag: js
---

If you have not worked on JavaScript yet or working on previous versions of JavaScript, there is a good chance that you haven't explored the new features and syntax that are added to JavaScript by ES6.
You may know ES6 by ECMASCRIPT 6 or ES2015, but they all are same.

In this post, we're going to dive through what are the new features and syntax that are provided by ES6.

<div class="toc" markdown="1">
<span class="gamma">Table of contents</span>
{:.no_toc}
* TOC
{:toc}
</div>

### Classes

Classes are not new in JavaScript, they are part of JavaScript from a long time ago. ES6 introduces a new way of writing Classes.

Here's a example of a traditional function based class:

```js
function Starks(name) {
  this.name = name;
  this.houseName = 'House Stark';
  this.seat = 'Winterfell';
}

Starks.prototype.getHouseName = function() {
  return this.houseName;
}

var starks = new Starks();
console.log('Seat: ' + starks.seat); // Seat: Winterfell
console.log('House: ' + starks.getHouseName()); // House: House Stark
```

While using ES6 we can use the class keyword for creating a class:

```js
class Starks {
  constructor(name) {
    this.name = name;
    this.houseName = 'House Stark';
    this.seat = 'Winterfell';
  }
  getHouseName() {
    return this.houseName;
  }
}

const starks = new Starks();
console.log('Seat: ' + starks.seat); // Seat: Winterfell
console.log('House: ' + starks.getHouseName()); // House: House Stark
```

We can also create static methods on classes with static keyword.

```js
class Starks {
  static words() {
    return 'Winter is coming!';
  }
}

console.log(Starks.words()); // 'Winter is coming!'
```

We can also extend classes using extend keyword

```js
class Jon extends Starks {
	getHouseName() {
  	return 'House Targaryen';
  }
}

const jon = new Jon();
console.log(jon.getHouseName()); // House Targaryen
```

### Let and Const

`let` and `const` are two new keywords for declaring variables in ES6. Unlike `var`, `let` and `const` are blocked scoped rather than function scope.

Didn't get it? Let me explain:

```js
function foo() {
  if (true) {
      var functionScoped = "I'm function scoped";
      let blockScoped = "I'm block scoped"; // Same applies to const
  }
  console.log(functionScoped); // I'm function scoped
  console.log(blockScoped); // Uncaught ReferenceError: blockScoped is not defined
}

foo();
```

Here variable `functionScoped` can be accessed outside of if block as `var` has the scope of function, so variable `functionScoped` can be used in entire `foo` function.
Where as variable `blockScoped` can only be accessed in the block it is declared, so variable `blockedScoped` can only be used in the if block.

So we got the difference between `var` vs `let` and `const` but what is the difference between `let` and `const`? Wondering why there are two keywords for declaring variables?

Let's get to it then:

The difference between `let` and `const` is that if the variable is going to change it's value and is going to reassigned a value then use `let` else `const`.
A value must be provided at the time of declaration of `const` variable. If you try to reassign a value to `const` variable, an error will be thrown (Uncaught TypeError: Assignment to constant variable).

Example:
```js
const PI = 3.14; // const is used here as value of PI is never going to change
const r = 5; // Assuming value of r will be set dynamically
let area = 0;

if (r > 0) area = PI * r * r; // Reassigning the let variable as r is a positive value

console.log('Area: '+ area);
```

There are some misconceptions of using const for object variables as we think what we can not change the value of a `const` variable but the following example will not throw error.

```js
const dob = {};
dob.date = 30;
dob.month = 8;
```

Here we are not reassigning value to const variable dob, we are adding a property to const variable dob which is not reassigning and thus no error.

### Arrow functions

Arrow functions are also know as fat functions or lambda functions.

Arrow functions introduces new syntax for writing functions and are always anonymous which means we can not define a named arrow function but we can assign arrow functions to let and const variables to give them a reference.

```js
function square(num) {
  return num * num;
}

// here (num) as the arguments of the function and => specifies the starting of function body.
const square = (num) => {
    return num * num;
}

// Note that if a function has only one argument, () can be avoided. e.x
const square = num => {
    return num * num;
}

// Note that if a function body has only one statement that returns a value, we can use shorthand like this.
const square = num => num * num;

// All of the functions declaration above
// will produce same output.

// Some other sugar syntax for arrow functions

// A function without an argument must have ()
// Same applies to functions without an argument and having function body
const foo = () => 'bar';

// Returning an object from arrow shorthand
// The return object is wrapped in () as {} means function body.
const foo = () => ({ foo: 'bar' });
```

Arrow functions has lexical `this`. what's lexical `this`? You might have noticed some code like this: `var self = this;` or `var that = this;`. Now we can avoid doing that by using arrow functions.

```js
// ES5
this.nums = [1,2,3,4,5,6,7,8,9];
this.odds = [];
var that = this;

// ES5 way 1
this.nums.forEach(function (num) {
    if (num % 2 || num === 1) that.odds.push(num);
});

// ES5 way 2
this.nums.forEach(function (num) {
    if (num % 2 || num === 1) this.odds.push(num);
}, this);

// ES5 way 3
this.nums.forEach(function (num) {
    if (num % 2 || num === 1) this.odds.push(num);
}.bind(this));

console.log('Odds: ' + this.odds);

// ES6
this.nums = [1,2,3,4,5,6,7,8,9];
this.odds = [];
this.nums.forEach((num) => {
    if (num % 2 || num === 1) this.odds.push(num);
});

console.log('Odds: ' + this.odds);
```

In way 2 and 3 of ES5 we can see that we had used this instead of that so what's the advantage of using arrow functions over binding this to the function? Binding this to a function is an slow operation and by binding `this` to a function we perform binding on each time that function is called.
Which means that performance is impacted and could be solved by arrow functions. The parent scoped this is passed to the arrow functions which we call as lexical this.

### Destructuring

Destructuring helps us to extract nested data from arrays or objects.

```js
const starks = [{ name: 'Arya' }, { name: 'Jon' }, { name: 'Sansa' }];

// Destructuring of array
const [arya, jon, sansa] = starks;

// I love arya and I only want her from starks then
const [arya] = starks;

// Well arya wants her sister Sansa but not Jon then,
const [arya, , sansa] = starks;

console.log(arya); // { name: 'Arya' }

// Destructuring of object
const { name } = arya;
console.log(name); // Arya

// Aliasing a property (just in case we already have a variable named `'name'`)
const { name: aryaName } = arya;
console.log(aryaName); // Arya

// Accessing nested values
const res = { data: { records: [1, 2] } };
const { data: { records } } = res;
console.log(records); // [1, 2]
```



### Enhanced Object Literals

Enhanced Object Literals things like property value shorthands, computed property keys and method shorthand.

Here is an property value shorthand example:
```js
// ES5
var data = [{ something: 'Important' }];
return { data: data};

// ES6
const data = [{ something: 'Important' }];
// Here { data } is same as { data: data }
return { data };
```

Here is an computed property keys example:
```js
// ES5
var name = 'Arya';
var starks = {};
starks['' + name] = { house: 'Stark', ability: 'many-faced gods' };
console.log(starks); // { Arya: { house: 'Stark', ability: 'many-faced gods' } }

// ES6
const name = 'Arya';
const starks = { [name]: { house: 'Stark', ability: 'many-faced gods' } };
console.log(starks); // { Arya: { house: 'Stark', ability: 'many-faced gods' } }
```

We have already used method shorthand in class. Here is an another example:
```js
// ES5
var calculations = {
    square: function(num) {
      return num * num;
    }
}


// ES6
const calculations = {
    // No : function
    square(num) {
      return num * num;
    }
}
```

### Template Literals

Template literals are string literals which allow the usage of embedded expressions. Those expressins can be anything that can have a computed value.

While strings are enclosed in single or double quotes, template literals are enclosed by back-ticks (``). Template literals can have place holders. Place holders are indicated by the Dollar sign followed by the curly braces `${expression}`.

Some examples:

```js
console.log(`This is plain string`);

const a = 5, b = 10;
console.log('The number is ' + a + '.'); // The number is 5.
console.log(`The number is ${a}.`); // The number is 5.

console.log('The addition of a and b is ' + (a + b) + '.'); // The number is 15.
// Simple expression
console.log(`The addition of a and b is ${a + b}.`); // The number is 15.

function add(a, b) {
	return a + b;
}

// Calling a function
console.log(`The addition of a and b is ${add(a, b)}.`); // The number is 15.

// Using ternary operator.
console.log(`The addition of the numbers a and b is ${add(a, b) % 2 === 0 ? 'even' : 'odd'}.`);

// Multi line 

// Without template literals
console.log('Text from line 1\n' +
'Text from line 2');
// Text from line 1
// Text from line 2

// With template literals
console.log(`Text from line 1
Text from line 2`);
// Text from line 1
// Text from line 2
```
### Iterators

ES6 gives many inbuilt functions to iterate over the arrays. This functions are fast and can avoid potential bugs or errors.
Do not use any loop to iterate over the array like `for-of, for` etc.

   > Use `map()` / `every()` / `filter()` / `find()` / `findIndex()` / `reduce()` / `some()` / ... to iterate over arrays, and `Object.keys()` / `Object.values()` / `Object.entries()` to produce arrays so you can iterate over objects.

Documentation for above methods can be found on [mozilla](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array).

Some examples: 

```js
const numbers = [1, 2, 3, 4, 5];

let sum = 0;
numbers.forEach((num) => {
  sum += num;
});
// sum = 15;

// Make use of the methods to improve code
const sum = numbers.reduce((total, num) => total + num, 0);
// sum = 15;

const increasedNumbers = numbers.map(num => num + 1);
// increasedNumbers = [2, 3, 4, 5, 6];
```

### Promises

ES6 brings built in promises in JavaScript. Many of you would be aware about the promises and why they come into existence.

We will not dive deep into Promises itself but we will demonstrate examples of promises:

```js
// A function that returns a promise after some time

// Without a promise constructor
function asyncExample(waitTime = 3000) {
	return setTimeout(() => Promise.resolve(), waitTime);
}

// With promise constructor
function asyncExample(waitTime = 3000) {
	// Prototype
	// <Promise>(resolve, reject)
	return new Promise((resolve) => setTimeout(resolve, waitTime));
}

asyncExample(5000).then(() => console.log('Will be logged after 5 secs.'));
```
There is much to be learned for the promises and luckly [Mozilla](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) has a really good documentation.
