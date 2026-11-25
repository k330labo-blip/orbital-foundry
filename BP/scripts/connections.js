// World coordinates: east +X, west -X, south +Z, north -Z.
// Bedrock geo.json mirrors X: world east must extend toward model -X.
export const CONNECTION_DIRECTIONS=[
 {name:"e",world:[1,0,0],model:[-1,0,0]},
 {name:"w",world:[-1,0,0],model:[1,0,0]},
 {name:"u",world:[0,1,0],model:[0,1,0]},
 {name:"d",world:[0,-1,0],model:[0,-1,0]},
 {name:"s",world:[0,0,1],model:[0,0,1]},
 {name:"n",world:[0,0,-1],model:[0,0,-1]},
];
export const WORLD_NEIGHBORS=CONNECTION_DIRECTIONS.map(direction=>direction.world);
