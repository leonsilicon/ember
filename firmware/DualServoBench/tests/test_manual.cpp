#include <cassert>
#include "../ManualControl.h"
int main(){
 Manual::State s;int l,r;s.targets(l,r);assert(!l&&!r&&!s.enabled[0]);
 s.session(123,0);assert(s.accept(123,1,1,0,0,100,10,0));s.targets(l,r);assert(l==100&&r==-100);assert(Manual::duty(l)==255);
 assert(!s.accept(123,1,2,0,0,100,10,10));assert(!s.accept(124,2,2,0,0,100,10,10));
 // No hold limit: keep feeding for a full minute.
 for(uint32_t t=100;t<=60000;t+=100){assert(s.accept(123,t,1,0,0,100,10,t));s.tick(t);s.targets(l,r);assert(l==100&&r==-100);}
 s.tick(60500);s.targets(l,r);assert(!l&&!r&&!s.linked);
 s.session(456,61000);assert(s.accept(456,1,0,1,-1,20,10,61000));s.tick(61020);assert(s.position[0]>1500&&s.position[1]<1500);
 const int pos=s.position[0];assert(s.accept(456,2,0,0,0,20,10,61030));s.tick(61050);assert(s.position[0]==pos&&s.enabled[0]);
 assert(s.accept(456,3,0,1,-1,20,100,61060));s.tick(61080);assert(s.position[0]==2500&&s.position[1]==500);
 assert(!s.accept(456,4,1,0,0,101,10,61090));
 s.session(789,0xffffff00);assert(s.accept(789,1,1,0,0,20,10,0xffffff00));s.tick(0xf4);assert(!s.linked);
 // Forward uses25; backward26 at the hardware mapping boundary.
 s.session(1,0);assert(s.accept(1,1,2,0,0,30,10,0));s.targets(l,r);assert(l==-30&&r==30);
}
